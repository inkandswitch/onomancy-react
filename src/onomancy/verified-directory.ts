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
import type {
  ChainFreshness,
  HostnameBinding,
  OnomancyRuntime,
} from "./runtime.js";

type Resolution =
  | { phase: "pending" }
  | {
      phase: "resolved";
      ids: string[];
      freshness?: ChainFreshness;
      lapsedSeconds?: number;
    }
  // The reason the DNS layer gave no usable answer, one phase per remedy:
  // `offline` says retry, `malformed` says fix the claim, `no-claim` says
  // the domain is not claiming anyone, `deferred` says wait for a clock —
  // and `chain-failed` and `replayed` are security signals: evidence
  // arrived and failed.
  | { phase: "offline" }
  | { phase: "malformed" }
  | { phase: "no-claim" }
  | { phase: "chain-failed" }
  | { phase: "replayed" }
  | { phase: "deferred" };

type Verdict =
  { phase: "pending" } | { phase: "done"; verdict: DesignationVerdict };

/**
 * Two maps, not one, because they answer to different rules.
 *
 * `resolutions` is the DNS layer: hostname to bound document ids. It is the
 * onomancy spec's *binding cache*, which requires entries to be re-verified
 * at use — a decision that depends on `now`, so memoizing it across time is
 * memoizing a function of an argument that was dropped. Doing that properly
 * needs certificate verification, which the Wasm binding does not expose, so
 * this half stays memoized and the limitation is recorded rather than hidden.
 *
 * `verdicts` is the designation layer: does the bound document belong to this
 * identity? That is a question about local keyhive state and the DNS spec has
 * nothing to say about it. It goes stale for an entirely local reason — the
 * document arrives — so {@link clearVerificationVerdicts} re-checks it
 * without discarding resolutions.
 */
interface CacheState {
  resolutions: Map<string, Resolution>;
  verdicts: Map<string, Verdict>;
  /**
   * Highest serial accepted per hostname — the serial ratchet.
   *
   * Lives beside the caches rather than inside `resolutions` because it
   * must **outlive** them. Resolutions are cleared on revalidation; the
   * ratchet must not be, or the memory a replay defence depends on would be
   * erased by the routine act of re-checking.
   *
   * Deliberately *not* a monotone maximum. A fresh chain may move it in
   * either direction, because a ratchet that only rises can be jammed by a
   * single forged high serial and could then never heal.
   */
  ratchet: Map<string, bigint>;
  listeners: Set<Subscriber>;
}

/**
 * One `subscribe` call.
 *
 * A wrapper rather than the bare function, because a `Set` of functions
 * deduplicates by identity: two components passing the same stable callback
 * — a `useCallback` with no dependencies, say — would register once, and the
 * first unsubscribe would silently cancel the second's subscription. Each
 * call gets its own object, so registrations count rather than collapse.
 */
interface Subscriber {
  readonly notify: () => void;
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
    ratchet: new Map(),
    listeners: new Set(),
  });
  return cache;
}

/**
 * Forget every resolution and verdict, so the next read verifies again.
 *
 * Subscribers are notified, since every claimed name reverts to `pending`.
 * Live subscriptions survive; only results are dropped.
 *
 * **The serial ratchet deliberately survives this.** It is not a cached
 * answer but a memory of the highest serial ever accepted per name, and a
 * replay defence that could be cleared by re-checking would defend nothing:
 * an attacker who can prompt a revalidation could erase the evidence that
 * their record is superseded. Nothing in this library clears it, which is
 * why there is no `clearSerialRatchet` beside the other two.
 */
export function clearVerificationCache(cache: VerificationCache): void {
  const state = states.get(cache);
  if (!state) return;
  state.resolutions.clear();
  state.verdicts.clear();
  for (const listener of state.listeners) listener.notify();
}

/**
 * Forget the designation verdicts, keeping DNS resolutions.
 *
 * A verdict is a claim about local keyhive state: whether the document a
 * domain designates belongs to this identity. It has one common way of going
 * stale — the document was not held when the claim was checked, and has since
 * arrived. Nothing about DNS changed, so re-resolving would be wasted DoH
 * traffic; only the local question needs asking again.
 *
 * Without this, an entry whose document arrives after the first read reads
 * `unsynced` for the life of the cache: "this device has not synced the
 * document", about a document the device is holding. Call it when keyhive
 * membership may have changed — {@link useOnomancyDirectory}'s `revalidate`
 * does exactly that.
 */
export function clearVerificationVerdicts(cache: VerificationCache): void {
  const state = states.get(cache);
  if (!state || state.verdicts.size === 0) return;
  state.verdicts.clear();
  for (const listener of state.listeners) listener.notify();
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
  const { resolutions, verdicts, ratchet, listeners } = stateOf(cache);

  /**
   * Whether this answer is a replay of something already superseded.
   *
   * Only a **stale** chain can be a replay. A fresh chain is the zone
   * speaking now, and is believed even when its serial is lower — that is
   * the escape hatch that lets a poisoned ratchet heal, and it is also what
   * makes legitimate re-registration of a domain possible.
   *
   * With no serial there is nothing to compare, so nothing is claimed: a
   * runtime too old to report one gets the pre-ratchet behaviour rather than
   * a fabricated verdict.
   */
  function isReplay(hostname: string, binding: HostnameBinding): boolean {
    if (binding.serial === undefined) return false;
    if (binding.freshness === "fresh") return false;

    const seen = ratchet.get(hostname);
    return seen !== undefined && binding.serial <= seen;
  }

  /**
   * Move the ratchet to this answer's serial.
   *
   * A fresh chain sets it in **either direction**; anything else may only
   * raise it. The downward move is deliberate and is the whole reason this
   * is not `Math.max`: without it, one forged far-future serial would lock
   * the name permanently, and the defence would become the attack.
   */
  function admitToRatchet(hostname: string, binding: HostnameBinding): void {
    if (binding.serial === undefined) return;

    const seen = ratchet.get(hostname);
    if (
      seen === undefined ||
      binding.freshness === "fresh" ||
      binding.serial > seen
    ) {
      ratchet.set(hostname, binding.serial);
    }
  }

  const notify = () => {
    // Snapshot: a listener may unsubscribe while being notified, and
    // mutating the set mid-iteration would skip whoever follows it.
    for (const listener of [...listeners]) listener.notify();
  };

  function resolutionFor(hostname: string): Resolution {
    const existing = resolutions.get(hostname);
    if (existing) return existing;

    // Decided here, from the claim itself: a syntactically impossible
    // hostname cannot be looked up, so there is nothing to wait for and no
    // network to blame. Never classified from message text — error strings
    // are prose, not a contract; anything not determined structurally stays
    // in the conservative bucket.
    if (!isSyntacticallyResolvable(hostname)) {
      const malformed: Resolution = { phase: "malformed" };
      resolutions.set(hostname, malformed);
      return malformed;
    }

    const pending: Resolution = { phase: "pending" };
    resolutions.set(hostname, pending);
    runtime.resolveBoundIds(hostname).then(
      (binding) => {
        // No parseable records proves nothing about any identity, the same
        // as not resolving at all. A mismatch requires a record that
        // designates someone.
        if (binding.ids.length === 0) {
          // Everything the zone published was dated past the skew bound.
          // Not an absence and not a refusal — those records ripen, and
          // the usual cause is this device's clock being behind.
          resolutions.set(
            hostname,
            binding.deferredSerials
              ? { phase: "deferred" }
              : { phase: "no-claim" }
          );
        } else if (isReplay(hostname, binding)) {
          // A stale chain bearing a serial no higher than one already
          // accepted for this name. The zone — or something on the path —
          // is serving a record we know to be superseded.
          resolutions.set(hostname, { phase: "replayed" });
        } else {
          admitToRatchet(hostname, binding);

          const resolved: Resolution = {
            phase: "resolved",
            ids: binding.ids.map(bareId),
          };
          if (binding.freshness !== undefined) {
            resolved.freshness = binding.freshness;
          }
          if (binding.lapsedSeconds !== undefined) {
            resolved.lapsedSeconds = binding.lapsedSeconds;
          }
          resolutions.set(hostname, resolved);
        }
        notify();
      },
      (error: unknown) => {
        resolutions.set(hostname, { phase: phaseForRejection(error) });
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

    // A contested binding is refused before any designation sees it.
    //
    // Record selection has already taken the highest serial and collapsed
    // agreeing duplicates, so more than one id here means two records claim
    // to be equally current and name *different* documents. The zone
    // contradicts itself, and there is no ground for preferring either.
    //
    // This must be refused centrally rather than left to each designation,
    // because the natural implementation is membership — `boundIds.includes`
    // — which accepts a contested set whenever the entry is any one of its
    // members. That turns "the zone disagrees with itself" into "verified",
    // and it is reachable by anyone who can get a same-serial record into
    // the RRset beside the real one.
    //
    // The verdict is `unknown`, not `excludes`: the zone has failed to say
    // who it designates, which is not the same as saying it is not this
    // entry.
    if (ids.length > 1) {
      const contested: Verdict = { phase: "done", verdict: "unknown" };
      verdicts.set(key, contested);
      return contested;
    }

    // `DnsDesignation` may return a verdict or a promise, so it may also
    // throw synchronously. `Promise.resolve(f())` evaluates `f()` first and
    // catches only asynchronous failure, so a synchronous throw would escape
    // through decorate() and lookup() into render — and, having never settled
    // the entry, leave it pending forever afterwards.
    let outcome: DesignationVerdict | Promise<DesignationVerdict>;
    try {
      outcome = designation(entry, ids, hostname);
    } catch {
      // A designation that throws has answered nothing.
      const answered: Verdict = { phase: "done", verdict: "unknown" };
      verdicts.set(key, answered);
      return answered;
    }

    const pending: Verdict = { phase: "pending" };
    verdicts.set(key, pending);
    Promise.resolve(outcome).then(
      (verdict) => {
        verdicts.set(key, { phase: "done", verdict });
        notify();
      },
      () => {
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
    if (
      resolution.phase === "offline" ||
      resolution.phase === "malformed" ||
      resolution.phase === "no-claim" ||
      resolution.phase === "chain-failed" ||
      resolution.phase === "replayed" ||
      resolution.phase === "deferred"
    ) {
      return { ...entry, dnsNameStatus: resolution.phase };
    }

    // A contested zone is decided structurally, before any designation is
    // consulted. Record selection has already taken the top serial and
    // collapsed agreeing duplicates, so more than one id means two records
    // of equal precedence name different documents.
    //
    // This must not go through `verdictFor`: every verdict it can return is
    // an answer about *this entry*, and the zone has not made one. The
    // remedy belongs to whoever controls the DNS records, so the status must
    // not read as "wait".
    if (resolution.ids.length > 1) {
      return { ...entry, dnsNameStatus: "contested" };
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

    // Freshness rides alongside the status rather than inside it. It grades
    // the chain window only and says nothing about acceptance, so a stale
    // `verified` is still verified — by evidence that has aged.
    if (resolution.freshness === undefined) {
      return { ...entry, dnsNameStatus: status };
    }

    const decorated: DirectoryEntry = {
      ...entry,
      dnsNameStatus: status,
      dnsNameFreshness: resolution.freshness,
    };
    if (resolution.lapsedSeconds !== undefined) {
      decorated.dnsNameLapsedSeconds = resolution.lapsedSeconds;
    }
    return decorated;
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
      const subscriber: Subscriber = { notify: listener };
      listeners.add(subscriber);
      // A fresh closure, not the raw listener: a base directory that
      // deduplicates listeners by identity would otherwise collapse two
      // subscriptions sharing one callback, and the first unsubscribe would
      // cancel the second subscriber's base updates.
      const unsubscribe = base.subscribe?.(() => listener());
      return () => {
        listeners.delete(subscriber);
        unsubscribe?.();
      };
    },
  };

  const publish = base.publish?.bind(base);
  if (publish) {
    directory.publish = (entry) => {
      // Verification results are decorations, never stored: they are computed
      // per lookup and would otherwise persist stale in the base directory.
      const {
        dnsNameStatus: _status,
        dnsNameFreshness: _freshness,
        dnsNameLapsedSeconds: _lapsed,
        ...stored
      } = entry;
      return publish(stored);
    };
  }

  return directory;
}

function bareId(id: string): string {
  return (id.startsWith("0x") ? id.slice(2) : id).toLowerCase();
}

/**
 * Why the DNS layer gave no answer, from the runtime's own `reason` when it
 * supplies one.
 *
 * Read off a property, never matched from message text: `reason` is a
 * contract; the message is prose and may change at any time.
 *
 * The mapping is by **remedy**, because that is the only thing the badge can
 * act on:
 *
 * | reason             | status         | what the reader should do |
 * |--------------------|----------------|---------------------------|
 * | `transport`        | `offline`      | retry — it may work       |
 * | `no-binding`       | `no-claim`     | nothing; there is nothing to prove |
 * | `invalid-hostname` | `malformed`    | fix the claim             |
 * | `chain-rejected`   | `chain-failed` | trust nothing from this zone |
 *
 * `no-binding` and `chain-rejected` are the pair that must not merge. The
 * first means DNS answered and there was nothing to prove; the second that
 * records arrived and failed. Only the second is a security signal, and
 * presenting it as an absence would hide it inside the most ordinary
 * outcome there is.
 *
 * An unrecognised or absent `reason` falls back to `offline`, which is the
 * conservative reading: it asserts only that the lookup did not complete.
 * Consumers on a runtime older than the typed-reason build land here, and
 * that is correct rather than degraded — the information genuinely is not
 * available from them.
 */
function phaseForRejection(
  error: unknown
): "offline" | "malformed" | "no-claim" | "chain-failed" {
  if (typeof error !== "object" || error === null) return "offline";

  switch ((error as { reason?: unknown }).reason) {
    case "invalid-hostname":
      return "malformed";
    case "no-binding":
      return "no-claim";
    case "chain-rejected":
      return "chain-failed";
    case "transport":
      return "offline";
    default:
      return "offline";
  }
}

/**
 * Whether a hostname could be looked up at all.
 *
 * Deliberately *permissive*: this decides only whether a query is possible,
 * not whether the name is good. Anything that might resolve is sent to the
 * resolver, which is the authority on the rest. The asymmetry is the point —
 * a false `malformed` accuses a claimant of a typo they did not make, while a
 * false pass merely costs one query that fails honestly.
 *
 * The rules here are the ones that make a lookup *impossible* rather than
 * merely unlikely:
 *
 * - fewer than two labels — dotless domains do not exist
 * - an empty label — a leading, trailing or doubled dot
 * - an all-digit final label — that is an IP literal, not a name
 * - a label over 63 octets, or a name over 253 — RFC 1035
 * - characters outside the A-label set
 */
function isSyntacticallyResolvable(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;

  const labels = hostname.split(".");
  if (labels.length < 2) return false;

  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }

  const tld = labels[labels.length - 1]!;
  return !/^[0-9]+$/.test(tld);
}
