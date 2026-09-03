import { bytesToHex } from "../bytes.js";

/**
 * A parsed onomancy name. Structurally `@inkandswitch/onomancy`'s `Name`,
 * declared here so this package needs no import of its own.
 */
export interface OnomancyName {
  /** The anchor in printed form: `~`, `@expede.wtf`, or `automerge:…`. */
  readonly anchor: string;
  /** The trust anchor kind: `"local"`, `"dns"`, or `"doc"`. */
  readonly anchorKind: string;
  /** The path segments, one edge hop each. */
  readonly segments: string[];
  /** The canonical printed form. */
  readonly value: string;
  /** Wasm handles are disposable; called when present. */
  free?(): void;
}

/**
 * A binding candidate as `classifyRecords` reports it. Structurally
 * `@inkandswitch/onomancy`'s `RecordCandidate`, declared here so this
 * package needs no import of its own.
 */
export interface OnomancyRecordCandidate {
  /** The bound document, as an `automerge:` anchor. */
  readonly document: string;
  /** The attested generation key (`g=`), canonical base64. */
  readonly generation: string;
  /** The serial as a decimal string: the space is u64, past `number`. */
  readonly serial: string;
}

/**
 * The `RRset` rules' outcome over one zone's TXT strings. Structurally
 * `@inkandswitch/onomancy`'s `RecordClassification`.
 */
export interface OnomancyClassification {
  /** The zone's word: the unique claim at the top serial. */
  readonly selected?: OnomancyRecordCandidate;
  /** Distinct claims tied at the top serial: equivocation, none picked. */
  readonly contested?: OnomancyRecordCandidate[];
  /** Bindings set aside: serial past the skew bound at the given clock. */
  readonly deferred: number;
  /** Records that are not `v=ONO` at all. */
  readonly foreign: number;
  /** `v=ONO` records with a tag newer than the module implements. */
  readonly unknownVersion: number;
  /** `v=ONO0` records that failed the strict grammar. */
  readonly malformed: number;
}

/**
 * The subset of `@inkandswitch/onomancy`'s exports this package needs supplied
 * by the application, so that the Wasm module is loaded once and only by the
 * host. See `KeyhiveRuntime` for the same pattern applied to keyhive.
 *
 * `classifyRecords` and `docAnchorBytes` first shipped in onomancy 0.3.0;
 * older builds cannot satisfy this interface. That is deliberate: the TXT
 * grammar and the selection rule are a trust root's parser, and this package
 * carrying its own copy is how two implementations drift — which is exactly
 * what happened, three security fixes at a time, before the rules moved into
 * the module every consumer already loads.
 */
export interface OnomancyModule {
  /**
   * Resolve a hostname's onomancy binding live over DoH, validated from the
   * IANA trust anchors baked into the Wasm. Resolves to
   * `{ hostname, records: string[], freshness, window, checkedAt, … }`.
   */
  resolveHostname(hostname: string, dohUrl?: string | null): Promise<unknown>;

  /**
   * The name grammar itself. Parsing claims through it rather than by hand
   * means this package cannot drift from the spec: canonicalisation,
   * dotless names, IP literals and label rules are all decided by the same
   * code that decides them everywhere else.
   */
  Name: new (raw: string) => OnomancyName;

  /**
   * The `RRset` rules over one zone's TXT strings: strict `v=ONO0` parsing,
   * deferral of far-future serials before selection, highest serial wins,
   * and ties contested on `(document, generation)` rather than picked.
   */
  classifyRecords(
    records: string[],
    nowSeconds?: number | null
  ): OnomancyClassification;

  /**
   * The 32 payload bytes of a doc anchor — the root document id. The
   * bytes-side counterpart of the `automerge:` anchors `classifyRecords`
   * emits, for consumers whose own vocabulary is raw ids.
   */
  docAnchorBytes(anchor: string): Uint8Array;
}

export interface OnomancyRuntimeOptions {
  /** DNS-over-HTTPS endpoint. The Wasm module's default when omitted. */
  dohUrl?: string;
  /**
   * Milliseconds since the epoch. Defaults to `Date.now`.
   *
   * Injectable because the serial skew bound is a decision about *now*, and
   * a test that cannot name the instant can only assert whatever behaviour
   * it happens to observe.
   */
  now?: () => number | bigint;
}

/**
 * How current the DNSSEC chain was when it was graded.
 *
 * - `fresh` — the chain's signature window covers the moment it was checked.
 * - `stale` — once-valid, window lapsed. **A risk signal, never a forgery
 *   signal**: a lapsed window is what offline operation looks like, so this
 *   must warn and must not gate access. The binding still shows.
 * - `deferred` — the window has not opened yet, nearly always client clock
 *   skew. Neither pass nor fail: it means "cannot judge", and it preempts
 *   the grade rather than sitting beside it.
 * - `undefined` — no chain was obtained, so the axis does not exist. Not the
 *   same as failing it.
 *
 * Orthogonal to `DnsNameStatus`, not a member of it. "Verified, checked just
 * now" and "verified, but the proof lapsed a week ago" are the same verdict
 * at two confidences; collapsing them would destroy the distinction between
 * *could not check* and *checked, and it has aged*.
 */
export type ChainFreshness = "fresh" | "stale" | "deferred";

/**
 * RFC 1035's limit on a fully-qualified domain name, plus one for the `@`
 * sigil. A DNS name *claim* carries no path, so nothing legitimate is longer.
 */
const MAX_DNS_NAME_LENGTH = 254;

/**
 * A DNSSEC-verified binding: the root document ids a hostname's
 * `_onomancy` TXT records designate.
 */
export interface HostnameBinding {
  hostname: string;
  /**
   * Hex-encoded 32-byte root document ids (ed25519 verifying keys) from the
   * `p=` field of each parseable `v=ONO0` record. Usually one; more during
   * a migration's dual-publish window.
   */
  ids: string[];
  /**
   * The serial of the winning record — the highest `n=` among those not set
   * aside as future-dated.
   *
   * Surfaced because it outlives the query. A verifier is required to
   * remember the highest serial it has accepted per name, so that a
   * stale-chain record bearing a *lower* serial can be recognised as a
   * replay of something already superseded. That comparison cannot happen
   * inside one resolution, because the attack is one record at a time
   * across two queries — never two records in one answer.
   */
  serial?: bigint;
  /**
   * Records of equal top precedence disagree on `(document, generation)`.
   * The zone has failed to say what it designates; nothing here can be
   * treated as the binding.
   */
  contested?: boolean;
  /**
   * How many records were set aside for reading too far in the future.
   *
   * Not an error and not a rejection: such a record *ripens*, and the spec
   * asks that it be deferred and retried rather than refused. Reported so a
   * caller can distinguish "this domain publishes nothing" from "everything
   * this domain publishes is dated ahead of my clock", which have opposite
   * remedies — the second is usually the reader's own clock being behind.
   */
  deferredSerials?: number;
  /**
   * The chain's grade at the moment it was checked, when the runtime reported
   * one. See `lapsedSeconds` for the magnitude behind a `stale` grade.
   */
  freshness?: ChainFreshness;
  /**
   * How far the chain's validity window had lapsed when it was checked, in
   * seconds. Present only when the runtime returned both the window and the
   * clock reading it graded against, and only when that grade was `stale` —
   * a fresh chain has not lapsed and a deferred one has not begun.
   *
   * This is the difference between "the proof aged out an hour ago", which
   * is ordinary for a device that has been asleep, and "the proof aged out
   * eight months ago", which is worth a person's attention. Rendering both
   * as the bare word *stale* throws that distinction away.
   */
  lapsedSeconds?: number;
  /**
   * Absolute difference between the runtime's clock reading and this host's,
   * in seconds, when both are known.
   *
   * Clock skew is *indistinguishable from genuine staleness* by grade alone:
   * a device an hour fast sees valid chains as `deferred`, and one badly
   * behind sees expired chains as `fresh`. A consumer that reports "the
   * proof has not started yet" to a user whose clock is wrong has blamed
   * the wrong party.
   */
  clockSkewSeconds?: number;
}

/**
 * Custom implementations note: `resolveBoundIds` MUST set `contested` when
 * records of equal top precedence disagree on `(document, generation)` —
 * including the same-document/different-generation case, which is carried
 * ONLY by the flag (the ids list has one entry, so a consumer cannot infer
 * the contest from it). An implementation that omits the flag silently
 * verifies mid-rotation zones.
 */
export interface OnomancyRuntime {
  /**
   * The DNSSEC-verified root document ids bound to `hostname`.
   *
   * Rejects on malformed hostnames, transport failures, and invalid chains.
   */
  resolveBoundIds(hostname: string): Promise<HostnameBinding>;

  /**
   * A claimed DNS name in canonical form: lowercased, with the leading `@`
   * and any trailing dot removed.
   *
   * Throws on anything the onomancy grammar rejects as a DNS anchor —
   * dotless names, IP literals, malformed labels — and on a claim that
   * carries path segments, since a claim names a host and not a path.
   */
  normalizeDnsName(raw: string): string;
}

/**
 * Build a runtime from the application's own onomancy import.
 *
 * Every member is an arrow function closing over `onomancy`, never a method
 * reading `this`. That is deliberate and load-bearing: consumers pass these
 * detached — `normalizeDnsName` goes to `ProfileEditor` as a prop — and a
 * member that grew a `this` would break every such call site at runtime
 * with nothing at the type level to warn them. Arrow functions have no own
 * `this`, so the mistake cannot be made here rather than merely not having
 * been made yet.
 */
export function createOnomancyRuntime(
  onomancy: OnomancyModule,
  options: OnomancyRuntimeOptions = {}
): OnomancyRuntime {
  return {
    resolveBoundIds: async (hostname) => {
      const outcome = await onomancy.resolveHostname(
        hostname,
        options.dohUrl ?? null
      );
      const freshness = freshnessOf(outcome);

      // The module's clock argument is epoch seconds (it refuses a
      // milliseconds reading as implausible); the injectable option stays
      // milliseconds because `Date.now` is the ordinary source. Flooring
      // widens the deferral horizon by under a second, which the spec's
      // five-minute skew bound dwarfs.
      const rawNow = (options.now ?? Date.now)();
      const nowSeconds =
        typeof rawNow === "bigint"
          ? Number(rawNow / 1000n)
          : Math.floor(rawNow / 1000);

      // The RRset rules live in the module — strict grammar, deferral
      // before selection, highest serial wins, ties contested on the pair
      // (document, generation) — so this package holds no parser of its
      // own to drift. What remains here is the mapping to this package's
      // id vocabulary (hex), via the module's own anchor decoder.
      const classified = onomancy.classifyRecords(
        recordsOf(outcome),
        nowSeconds
      );

      const leaders = classified.selected
        ? [classified.selected]
        : (classified.contested ?? []);
      const ids = [
        ...new Set(
          leaders.map((claim) =>
            bytesToHex(onomancy.docAnchorBytes(claim.document))
          )
        ),
      ];

      const binding: HostnameBinding = { hostname, ids };
      const [first] = leaders;
      if (first !== undefined) binding.serial = BigInt(first.serial);
      if (classified.contested) binding.contested = true;
      if (classified.deferred > 0) {
        binding.deferredSerials = classified.deferred;
      }
      if (freshness !== undefined) binding.freshness = freshness;

      // The window and the clock reading are the inputs to the grade,
      // returned beside it so a caller can check the work. Both are OPTIONAL
      // and must stay so: the module is injected, so the build in play is
      // whatever the consumer installed, and older builds omit these fields.
      // Absence degrades to "no magnitude", never to a throw.
      const chainWindow = validityWindowOf(outcome);
      const checkedAt = finiteSeconds(
        (outcome as { checkedAt?: unknown } | null)?.checkedAt
      );

      if (checkedAt !== undefined) {
        binding.clockSkewSeconds = Math.abs(
          checkedAt - Math.floor(Date.now() / 1000)
        );
      }

      if (freshness === "stale" && chainWindow && checkedAt !== undefined) {
        const lapsed = checkedAt - chainWindow.expiration;
        // Only a positive lapse is meaningful. A non-positive one would mean
        // the runtime graded stale against a window it still sits inside,
        // which is a contradiction we report as "no magnitude" rather than
        // as a negative age.
        if (lapsed > 0) binding.lapsedSeconds = lapsed;
      }

      return binding;
    },

    normalizeDnsName: (raw) => {
      // Guarded here rather than left to the module: a library cannot
      // choose its consumer's build, and older onomancy builds trap on a
      // non-string with `RuntimeError: memory access out of bounds` — an
      // unrecoverable Wasm fault, not a catchable error. One `typeof` is the
      // difference between a caught error and a dead module.
      if (typeof raw !== "string") {
        throw new TypeError(
          `A DNS name claim must be a string, got ${typeof raw}`
        );
      }

      const trimmed = raw.trim();

      // Bounded before parsing. The upstream label walk is superlinear in
      // the segment count, so an absurd input is a denial of service rather
      // than a slow parse. A DNS name is capped at 253 octets by RFC 1035
      // and a claim carries no path, so anything longer is already invalid
      // — rejecting it early costs nothing that a legitimate name needs.
      if (trimmed.length > MAX_DNS_NAME_LENGTH) {
        throw new Error(
          `A DNS name cannot exceed ${MAX_DNS_NAME_LENGTH} characters`
        );
      }

      // The grammar requires a sigil; a claim is stored without one.
      const spelled = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;

      const name = new onomancy.Name(spelled);
      try {
        if (name.anchorKind !== "dns") {
          throw new Error(`Not a DNS name: "${raw}"`);
        }
        if (name.segments.length > 0) {
          throw new Error(`A DNS name claim cannot have a path: "${raw}"`);
        }
        return name.anchor.slice(1);
      } finally {
        name.free?.();
      }
    },
  };
}

/** A finite, non-negative epoch-seconds reading, or `undefined`. */
function finiteSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The chain's signature validity window, when the runtime reported a
 * coherent one.
 *
 * A window whose expiration precedes its inception is discarded rather than
 * passed on: it cannot be used to compute an age, and a caller doing
 * arithmetic on it would get a plausible-looking negative number instead of
 * an absence.
 */
function validityWindowOf(
  outcome: unknown
): { inception: number; expiration: number } | undefined {
  if (typeof outcome !== "object" || outcome === null) return undefined;
  const raw = (outcome as { window?: unknown }).window;
  if (typeof raw !== "object" || raw === null) return undefined;

  const inception = finiteSeconds((raw as { inception?: unknown }).inception);
  const expiration = finiteSeconds(
    (raw as { expiration?: unknown }).expiration
  );
  if (inception === undefined || expiration === undefined) return undefined;

  return expiration >= inception ? { inception, expiration } : undefined;
}

/**
 * The chain grade in a `resolveHostname` outcome, when it reported one.
 *
 * Unknown values are dropped rather than passed through: this feeds a
 * security-adjacent display, and a grade nobody recognises should read as
 * "no grade" rather than as a string rendered verbatim.
 */
function freshnessOf(outcome: unknown): ChainFreshness | undefined {
  if (typeof outcome !== "object" || outcome === null) return undefined;
  const grade = (outcome as { freshness?: unknown }).freshness;
  return grade === "fresh" || grade === "stale" || grade === "deferred"
    ? grade
    : undefined;
}

/**
 * The TXT strings in a `resolveHostname` outcome. Read structurally: the
 * module is injected, so the build in play is whatever the consumer
 * installed, and a missing or oddly-shaped field is an empty set rather
 * than a throw. A foreign or malformed neighbour is the classifier's to
 * tally, not ours to pre-filter — only non-strings are dropped, since the
 * classifier refuses those wholesale.
 */
function recordsOf(outcome: unknown): string[] {
  if (typeof outcome !== "object" || outcome === null) return [];
  const records = (outcome as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  return records.filter(
    (record): record is string => typeof record === "string"
  );
}
