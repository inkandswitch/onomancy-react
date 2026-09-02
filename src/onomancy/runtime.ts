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
 * The subset of `@inkandswitch/onomancy`'s exports this package needs supplied
 * by the application, so that the Wasm module is loaded once and only by the
 * host. See `KeyhiveRuntime` for the same pattern applied to keyhive.
 */
export interface OnomancyModule {
  /**
   * Resolve a hostname's onomancy binding live over DoH, validated from the
   * IANA trust anchors baked into the Wasm. Resolves to
   * `{ hostname, links, freshness, records: string[] }`.
   */
  resolveHostname(hostname: string, dohUrl?: string | null): Promise<unknown>;

  /**
   * The name grammar itself. Parsing claims through it rather than by hand
   * means this package cannot drift from the spec: canonicalisation,
   * dotless names, IP literals and label rules are all decided by the same
   * code that decides them everywhere else.
   */
  Name: new (raw: string) => OnomancyName;
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
 * How far ahead of the local clock a serial may read before it is set aside.
 *
 * Serials are millisecond timestamps, so a record from a publisher whose
 * clock runs slightly fast is ordinary and must not be punished. A record
 * from *years* ahead is not a clock — it is an attempt to jam the ratchet at
 * a value nothing honest will ever exceed.
 *
 * The bound is what makes a ratchet safe to have at all. With it, a transient
 * attacker can push the ratchet at most five minutes past wall clock, and an
 * honest publisher — minting `max(now_ms, last + 1)` — outgrows the poison
 * within the window. Without it, one forged record locks the name forever,
 * and the ratchet becomes the attack rather than the defence.
 */
const SERIAL_SKEW_BOUND_MS = 5n * 60n * 1000n;

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
      const rawNow = (options.now ?? Date.now)();
      const nowMs =
        typeof rawNow === "bigint" ? rawNow : BigInt(Math.floor(rawNow));
      const selection = boundIdsOf(outcome, nowMs);

      const binding: HostnameBinding = { hostname, ids: selection.ids };
      if (selection.serial !== undefined) binding.serial = selection.serial;
      if (selection.contested) binding.contested = true;
      if (selection.deferredSerials > 0) {
        binding.deferredSerials = selection.deferredSerials;
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

/** The outcome of choosing among a hostname's `v=ONO0` records. */
interface RecordSelection {
  ids: string[];
  serial?: bigint;
  deferredSerials: number;
  /** Records of equal top precedence disagree on (document, generation). */
  contested?: boolean;
}

/**
 * The `p=` document ids a `resolveHostname` outcome designates, with the
 * serial that won and a count of records set aside as future-dated.
 *
 * Order of operations is load-bearing and comes from the spec: **deferral
 * precedes movement.** A record reading too far ahead is set aside *before*
 * selection, so it can never become the winner and therefore never reaches
 * the ratchet. Reversing these two steps would let a forged far-future
 * serial jam the ratchet at a value no honest publisher will ever exceed —
 * turning the defence into the attack.
 */
function boundIdsOf(outcome: unknown, nowMs: bigint): RecordSelection {
  const none: RecordSelection = { ids: [], deferredSerials: 0 };
  if (typeof outcome !== "object" || outcome === null) return none;
  const records = (outcome as { records?: unknown }).records;
  if (!Array.isArray(records)) return none;

  // Parse every record, keeping only those that are `v=ONO0` and well formed.
  // A foreign or malformed TXT record beside a valid one is normal — a zone
  // holds records for many purposes — so an unparseable neighbour must not
  // fail the set.
  const parsed: Ono0Record[] = [];
  for (const record of records) {
    if (typeof record !== "string") continue;
    const ono0 = parseRecord(record);
    if (ono0 !== undefined) parsed.push(ono0);
  }

  // Set aside anything dated beyond the skew bound. Deferred, not rejected:
  // these ripen as the clock advances, so a publisher whose clock runs a
  // little fast is delayed rather than refused.
  const horizon = nowMs + SERIAL_SKEW_BOUND_MS;
  const eligible = parsed.filter((record) => record.serial <= horizon);
  const deferredSerials = parsed.length - eligible.length;

  if (eligible.length === 0) return { ids: [], deferredSerials };

  // Highest serial wins. RRset order is *not* significant — a resolver may
  // return the same set in a different order on each query — so taking
  // `records[0]` would make the answer depend on which shuffle arrived.
  // The serial is the publisher's own statement of which record supersedes.
  //
  // Compared as `bigint` throughout. The serial space is u64, and `Number`
  // silently equates neighbours near its top — which would turn a genuine
  // supersession into a tie, and a tie is reported as a contested zone. A
  // domain correctly superseding its own record would show to every visitor
  // as misconfigured. `Math.max` is avoided for the same reason: it coerces
  // back through `number` at precisely the comparison the bigint exists to
  // protect.
  let top = eligible[0]!.serial;
  for (const record of eligible) if (record.serial > top) top = record.serial;

  const leaders = eligible.filter((record) => record.serial === top);
  const distinct = [...new Set(leaders.map((record) => record.docIdHex))];
  // Contested-ness is keyed on the pair (document, generation), matching the
  // reference verifier. Two records naming the same document with different
  // generation keys at a tied serial are a rotation caught mid-flight; the
  // one-shot RRset rule has no lineage evidence to order them, so it refuses
  // rather than picking a generation arbitrarily.
  const pairs = new Set(
    leaders.map((record) => record.docIdHex + " " + record.generation)
  );

  // Agreement at the top serial, including the ordinary single-record case.
  if (pairs.size === 1) {
    return { ids: distinct, serial: top, deferredSerials };
  }

  return { ids: distinct, serial: top, deferredSerials, contested: true };
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

/** One parsed `v=ONO0` TXT record. */
export interface Ono0Record {
  /** The hex-encoded root document id from `p=`. */
  readonly docIdHex: string;
  /**
   * The `g=` generation key, as spelled in the record.
   *
   * Part of the zone-state key: contested-ness is decided on the pair
   * `(document, generation)`, so same-document-different-generation records
   * tied at the top serial are a rotation caught mid-flight — a contest, not
   * agreeing duplicates. This matches the reference verifier's
   * `best_of_document`, where a non-unique undominated set is contested by
   * construction.
   */
  readonly generation: string;
  /**
   * The `n=` serial, as a `BigInt`.
   *
   * Not a `number`. The serial space is the full u64 range —
   * `max(now_ms, last + 1)` is a publisher *recommendation*, not a bound, and
   * verifiers must accept any u64. `u64::MAX` is 18446744073709551615 against
   * `Number.MAX_SAFE_INTEGER` of 9007199254740991, so a conformant serial can
   * exceed what a `number` represents exactly.
   *
   * Every serial in the wild today is a millisecond timestamp (~1.8e12) and
   * would survive as a `number`, which is exactly why this would break
   * silently and late. Do not "simplify" it back on the grounds that the
   * grammar already caps the digit count — 20 digits is the u64 limit, not the
   * safe-integer limit.
   */
  readonly serial: bigint;
}

/**
 * Canonical decimal, per the DNS anchoring spec: no leading zeros, at most 20
 * digits, no sign, no whitespace. `Serial::parse` upstream rejects each of
 * those with a distinct error (`LeadingZero`, `TooManyDigits`, `Overflow`);
 * we only need the same verdict, not the same diagnosis.
 */
const ONO0 =
  /^v=ONO0;k=ed25519;n=(0|[1-9][0-9]{0,19});g=([A-Za-z0-9+/]+={0,2});p=([A-Za-z0-9+/]+={0,2})$/;

const U64_MAX = 18446744073709551615n;

/**
 * One TXT record parsed, or `undefined` when it is not a well-formed `v=ONO0`
 * record. Parsing is strict within the known tag, per the DNS anchoring spec:
 * exact field order, known fields only, canonical integers.
 *
 * Strictness in this direction is the safe one. Accepting a record the
 * protocol rejects means resolving a name a conformant verifier refuses — two
 * users, same zone, different answers, no error anywhere.
 *
 * Hand-written on purpose: this is the TXT wire format, which `Name` does not
 * parse. `Name` decides what a *name* is; this decides what a *record* is.
 * Upstream has `TxtRecord::parse` and `classify()` already written; when they
 * are exposed to JS this whole function should be deleted rather than
 * maintained.
 */
// ---- ed25519 point validity (RFC 8032 §5.1.3 decompression) ----------------
//
// The grammar requires g= and p= to decode to VALID curve points, not merely
// 32 bytes: "decoders MUST reject a unit whose key field does not decompress,
// even where that field is never verified against" (specs/serialization.md).
// A 32-byte string that cannot denote a key is not the canonical encoding of
// anything, and parsers that disagree about whether such a record exists
// diverge on every selection it feeds.
//
// Implemented with bare BigInt because this library imports only React: no
// crypto dependency is available, WebCrypto key import is async (this parser
// is sync) and its point validation is implementation-defined anyway. This is
// validity only — no key material is used for anything.

const ED_P = (1n << 255n) - 19n;
/** -121665/121666 mod p, the curve constant d. */
const ED_D =
  37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let b = base % mod;
  if (b < 0n) b += mod;
  let result = 1n;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Precomputed 2^((p minus 1)/4), the square-root adjustment factor. */
const ED_SQRT_ADJ = modPow(2n, (ED_P - 1n) / 4n, ED_P);

/** Whether 32 bytes decompress to a point on the edwards25519 curve. */
function isCurvePoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  // Little-endian y with the top bit as the x-parity flag.
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  const xParity = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= ED_P) return false;

  // Solve x^2 = (y^2 - 1) / (d*y^2 + 1).
  const y2 = (y * y) % ED_P;
  const u = (y2 - 1n + ED_P) % ED_P;
  const v = (ED_D * y2 + 1n) % ED_P;

  // Candidate root: x = u * v^3 * (u * v^7)^((p minus 5)/8).
  const v3 = (v * v * v) % ED_P;
  const v7 = (v3 * v3 * v) % ED_P;
  let x = (u * v3 * modPow((u * v7) % ED_P, (ED_P - 5n) / 8n, ED_P)) % ED_P;

  const vx2 = (v * x * x) % ED_P;
  if (vx2 === u) {
    // x is the root.
  } else if (vx2 === (ED_P - u) % ED_P) {
    x = (x * ED_SQRT_ADJ) % ED_P;
  } else {
    return false;
  }

  // x = 0 cannot carry a sign bit.
  if (x === 0n && xParity === 1n) return false;
  return true;
}

export function parseRecord(record: string): Ono0Record | undefined {
  // A TXT record longer than 255 characters cannot have come from a single
  // conformant character-string; the canonical grammar rejects it outright.
  if (record.length > 255) return undefined;

  const match = record.match(ONO0);
  if (!match) return undefined;

  const serial = BigInt(match[1]);
  if (serial > U64_MAX) return undefined;

  // g= is constrained identically to p=: it must decode to exactly 32 bytes.
  // A generation key of any other length is malformed, not lenient-parseable
  // — the canonical grammar routes both fields through the same decoder.
  const generationBytes = base64ToBytes(match[2]!);
  if (generationBytes === undefined || generationBytes.length !== 32) {
    return undefined;
  }
  if (!isCurvePoint(generationBytes)) return undefined;

  const bytes = base64ToBytes(match[3]);
  if (bytes === undefined || bytes.length !== 32) return undefined;
  if (!isCurvePoint(bytes)) return undefined;

  return { docIdHex: bytesToHex(bytes), generation: match[2]!, serial };
}

/** The hex-encoded root document id of one TXT record. See {@link parseRecord}. */
export function parseRecordDocId(record: string): string | undefined {
  return parseRecord(record)?.docIdHex;
}

function base64ToBytes(base64: string): Uint8Array | undefined {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    // Canonical spellings only. atob is forgiving - it accepts unpadded
    // input and ignores nonzero trailing bits in the final character - so
    // without the round-trip, one key has many spellings and parsers
    // disagree about which records exist (the differential class the
    // grammar's strict-decoding rule exists to kill; the reference decoder
    // "requires canonical padding and rejects set trailing bits").
    if (btoa(String.fromCharCode(...bytes)) !== base64) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}
