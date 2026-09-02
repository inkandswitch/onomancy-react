import type {
  DirectoryEntry,
  DnsNameStatus,
  NameDirectory,
} from "../directory/types.js";
import {
  idEqualityDesignation,
  type DesignationVerdict,
  type DnsDesignation,
} from "./designation.js";
import type { OnomancyRuntime } from "./runtime.js";

type Resolution =
  | { phase: "pending" }
  | { phase: "resolved"; ids: string[] }
  | { phase: "unreachable" };

type Verdict =
  { phase: "pending" } | { phase: "done"; verdict: DesignationVerdict };

interface CacheState {
  resolutions: Map<string, Resolution>;
  verdicts: Map<string, Verdict>;
  listeners: Set<() => void>;
}

/**
 * Verification results held across directory rebuilds.
 *
 * A directory backed by a live Automerge document is never referentially
 * stable — the document is a new object after every change, so anything
 * memoized on it is rebuilt on every write. A cache held inside the
 * directory would therefore be discarded on every write, re-resolving every
 * claimed hostname over DoH and abandoning whatever was already in flight.
 * Hoisting the cache out of the directory is what makes rebuilds free.
 *
 * Opaque on purpose: hold one, pass it in, and clear it when you want a
 * re-check. {@link useOnomancyDirectory} keeps one for you.
 */
export interface VerificationCache {
  readonly kind: "onomancy-verification-cache";
}

const states = new WeakMap<VerificationCache, CacheState>();

/** A cache with nothing in it yet. */
export function createVerificationCache(): VerificationCache {
  const cache: VerificationCache = { kind: "onomancy-verification-cache" };
  states.set(cache, {
    resolutions: new Map(),
    verdicts: new Map(),
    listeners: new Set(),
  });
  return cache;
}

/**
 * Forget every resolution and verdict, so the next read verifies again.
 *
 * Subscribers are notified, since every claimed name reverts to `pending`.
 * Live subscriptions survive; only results are dropped.
 */
export function clearVerificationCache(cache: VerificationCache): void {
  const state = states.get(cache);
  if (!state) return;
  state.resolutions.clear();
  state.verdicts.clear();
  for (const listener of state.listeners) listener();
}

function stateOf(cache: VerificationCache): CacheState {
  const state = states.get(cache);
  if (!state) throw new Error("Not a verification cache from this module");
  return state;
}

export interface OnomancyDirectoryOptions {
  /**
   * Decides whether the bound root documents designate an entry's identity.
   * Defaults to {@link idEqualityDesignation} (the bound id is the identity).
   * Pass `createKeyhiveDesignation` for domains that bind a shared root
   * namestore document whose admins own the name.
   */
  designation?: DnsDesignation;
  /**
   * Where verification results live. Defaults to a fresh cache, which means
   * results last exactly as long as this directory does. Hoist one to keep
   * them across rebuilds — {@link useOnomancyDirectory} does.
   */
  cache?: VerificationCache;
  /** Overrides the base directory's notice. */
  notice?: string;
}

/**
 * Wrap a directory so entries that claim a DNS name (`entry.dnsName`) carry a
 * verification status (`entry.dnsNameStatus`).
 *
 * Verification is two layers, checked lazily the first time an entry is read:
 *
 * 1. DNS: the hostname's `_onomancy` TXT record is fetched over DoH and
 *    validated by DNSSEC from the IANA root, yielding root document ids.
 * 2. Designation: does a bound document belong to this identity? By default
 *    the bound id must be the identity itself; a keyhive designation accepts
 *    admins of a shared root document instead.
 *
 * Results go in the cache from `options.cache`, keyed by hostname and by
 * `(hostname, identity)`, so a rebuilt directory sharing that cache neither
 * re-resolves what is known nor re-issues what is already in flight.
 * Subscribers are notified when a check lands — including subscribers that
 * arrived after it started, which is what stops a rebuild from stranding a
 * result nobody is listening for.
 *
 * Statuses follow the rules on {@link DnsNameStatus}.
 */
export function createOnomancyDirectory(
  base: NameDirectory,
  runtime: OnomancyRuntime,
  options: OnomancyDirectoryOptions = {}
): NameDirectory {
  const designation = options.designation ?? idEqualityDesignation;
  const cache = options.cache ?? createVerificationCache();
  const { resolutions, verdicts, listeners } = stateOf(cache);

  const notify = () => {
    for (const listener of listeners) listener();
  };

  function resolutionFor(hostname: string): Resolution {
    const existing = resolutions.get(hostname);
    if (existing) return existing;

    const pending: Resolution = { phase: "pending" };
    resolutions.set(hostname, pending);
    runtime.resolveBoundIds(hostname).then(
      (binding) => {
        // No parseable records proves nothing about any identity, the same
        // as not resolving at all. A mismatch requires a record that
        // designates someone.
        resolutions.set(
          hostname,
          binding.ids.length === 0
            ? { phase: "unreachable" }
            : { phase: "resolved", ids: binding.ids.map(bareId) }
        );
        notify();
      },
      () => {
        resolutions.set(hostname, { phase: "unreachable" });
        notify();
      }
    );
    return pending;
  }

  function verdictFor(
    entry: DirectoryEntry,
    hostname: string,
    ids: string[]
  ): Verdict {
    const key = `${hostname} ${bareId(entry.id)}`;
    const existing = verdicts.get(key);
    if (existing) return existing;

    const pending: Verdict = { phase: "pending" };
    verdicts.set(key, pending);
    Promise.resolve(designation(entry, ids, hostname)).then(
      (verdict) => {
        verdicts.set(key, { phase: "done", verdict });
        notify();
      },
      () => {
        // A designation that throws has answered nothing.
        verdicts.set(key, { phase: "done", verdict: "unknown" });
        notify();
      }
    );
    return pending;
  }

  function decorate(entry: DirectoryEntry): DirectoryEntry {
    if (!entry.dnsName) return entry;

    let hostname: string;
    try {
      hostname = runtime.normalizeDnsName(entry.dnsName);
    } catch {
      return { ...entry, dnsNameStatus: "invalid" };
    }

    const resolution = resolutionFor(hostname);
    if (resolution.phase === "pending") {
      return { ...entry, dnsNameStatus: "pending" };
    }
    if (resolution.phase === "unreachable") {
      return { ...entry, dnsNameStatus: "unreachable" };
    }

    const verdict = verdictFor(entry, hostname, resolution.ids);
    const status: DnsNameStatus =
      verdict.phase === "pending"
        ? "pending"
        : verdict.verdict === "designates"
          ? "verified"
          : verdict.verdict === "excludes"
            ? "mismatch"
            : "unsynced";
    return { ...entry, dnsNameStatus: status };
  }

  const directory: NameDirectory = {
    source: `onomancy(${base.source})`,
    trust: base.trust,
    writable: base.writable,
    enumerable: base.enumerable,
    notice: options.notice ?? base.notice,

    lookup(id) {
      const entry = base.lookup(id);
      return entry && decorate(entry);
    },

    list() {
      return base.list().map(decorate);
    },

    subscribe(listener) {
      // Into the cache's set, not this directory's: a check started before a
      // rebuild must still reach whoever is listening when it lands.
      listeners.add(listener);
      const unsubscribe = base.subscribe?.(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe?.();
      };
    },
  };

  const publish = base.publish?.bind(base);
  if (publish) {
    directory.publish = (entry) => {
      // The status is a decoration, never stored.
      const { dnsNameStatus: _status, ...stored } = entry;
      return publish(stored);
    };
  }

  return directory;
}

function bareId(id: string): string {
  return (id.startsWith("0x") ? id.slice(2) : id).toLowerCase();
}
