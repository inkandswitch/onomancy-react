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
import { normalizeDnsName, type OnomancyRuntime } from "./runtime.js";

type Resolution =
  | { phase: "pending" }
  | { phase: "resolved"; ids: string[] }
  | { phase: "unreachable" };

type Verdict =
  { phase: "pending" } | { phase: "done"; verdict: DesignationVerdict };

export interface OnomancyDirectoryOptions {
  /**
   * Decides whether the bound root documents designate an entry's identity.
   * Defaults to {@link idEqualityDesignation} (the bound id is the identity).
   * Pass `createKeyhiveDesignation` for domains that bind a shared root
   * namestore document whose admins own the name.
   */
  designation?: DnsDesignation;
  /** Overrides the base directory's notice. */
  notice?: string;
}

/**
 * Wrap a directory so entries that claim a DNS name (`entry.dnsName`) carry a
 * verification status (`entry.dnsNameStatus`).
 *
 * Verification is two layers, checked lazily the first time an entry is read
 * and cached for the directory's lifetime (build a fresh one to re-check):
 *
 * 1. DNS: the hostname's `_onomancy` TXT record is fetched over DoH and
 *    validated by DNSSEC from the IANA root, yielding root document ids.
 * 2. Designation: does a bound document belong to this identity? By default
 *    the bound id must be the identity itself; a keyhive designation accepts
 *    admins of a shared root document instead.
 *
 * Subscribers are notified when a check lands, so a `DirectoryProvider`
 * re-renders with the result.
 */
export function createOnomancyDirectory(
  base: NameDirectory,
  runtime: OnomancyRuntime,
  options: OnomancyDirectoryOptions = {}
): NameDirectory {
  const designation = options.designation ?? idEqualityDesignation;
  const resolutions = new Map<string, Resolution>();
  const verdicts = new Map<string, Verdict>();
  const listeners = new Set<() => void>();
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
      hostname = normalizeDnsName(entry.dnsName);
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
