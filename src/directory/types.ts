/** Whether a directory's names are self-asserted or proven. */
export type DirectoryTrust = "unverified" | "verified";

/** What an entry's id refers to. Groups are named here like individuals are. */
export type DirectoryEntryKind = "individual" | "group";

/**
 * Where a DNS name claim stands with a verifying directory.
 *
 * - `pending`: the claim is being resolved.
 * - `verified`: a DNSSEC-validated `_onomancy` TXT record designates a
 *   document this id administers. **One-directional — see below.**
 * - `mismatch`: the record designates a different id.
 * - `contested`: the zone publishes two records of equal precedence naming
 *   different documents. It has failed to say who it designates — which is
 *   not the same as saying it is not this id.
 * - `offline`: the DNS layer could not be reached at all.
 * - `malformed`: the claim is a syntactically invalid hostname, so no query
 *   was ever possible. The remedy is in the claim, not the network.
 * - `no-claim`: DNS answered and the domain publishes no usable `v=ONO0`
 *   record. Includes records that resolve but fail strict parsing. **Not a
 *   security signal** — there was nothing to prove, and nothing failed.
 * - `chain-failed`: records arrived and failed DNSSEC validation. **This is
 *   the security signal.** A misconfigured zone and active interference are
 *   indistinguishable from here, and neither is the claimant's doing, so it
 *   accuses nobody — but it must never be rendered as an absence or as
 *   something retrying will fix.
 * - `replayed`: a stale chain carried a serial no higher than one already
 *   accepted for this name. The zone — or something on the path — served a
 *   record known to be superseded. **A security signal.**
 * - `deferred`: every record the zone published is dated beyond the clock
 *   skew bound. Not an absence and not a refusal: such records *ripen*. The
 *   usual cause is this device's clock running behind.
 * - `unsynced`: the domain designates a document this device has not synced,
 *   so membership cannot be checked yet. Proves nothing either way.
 * - `invalid`: the claim is not a DNS name at all.
 *
 * ### Why the non-verdicts are separate values
 *
 * They carry different remedies, and the remedy is the only thing a badge
 * can act on: retry (`offline`), fix the input (`malformed`), nothing to
 * prove (`no-claim`), wait (`unsynced`, `deferred`, `pending`). The two
 * security signals — `chain-failed`, `replayed` — are not non-answers and
 * must never render as absences. Collapsing any of these tells a user with
 * a typo to check their network.
 *
 * ## Rules for anyone producing a status
 *
 * This library renders these twelve values; it does not require that it be
 * the thing that computes them. Applications that verify claims themselves must
 * follow the same rules, because the badge means the same thing to a reader
 * whichever code produced it.
 *
 * 1. **`mismatch` requires a record that designates somebody.** A hostname
 *    that resolves and DNSSEC-validates but whose records all fail strict
 *    `v=ONO0` parsing proves nothing about any identity, so it is
 *    `no-claim`. This is not hypothetical: a live record was once a
 *    hex-encoded `g=` field followed by a truncated `p=`, and every parse
 *    rejected. Reporting that as `mismatch` would accuse the claimant on
 *    the strength of somebody's typo.
 * 2. **The non-answers are never a weak `mismatch`.** `offline`,
 *    `malformed`, `no-claim`, `contested` and `unsynced` all mean the
 *    question was not answered. Do not collapse them into `mismatch`, and
 *    do not collapse them into each other — they carry different remedies,
 *    which is the entire reason they are separate values.
 * 3. **`verified` requires positive evidence**, never the absence of
 *    contrary evidence.
 * 4. **`contested` is not `mismatch`.** A zone naming two documents at equal
 *    precedence has contradicted itself. Preferring either would manufacture
 *    a verdict the zone does not support.
 * 5. **`no-claim` and `chain-failed` are opposites, not neighbours.** The
 *    first means the domain said nothing; the second that it said something
 *    which failed to verify. Collapsing them buries the only case here with
 *    a security reading inside the most ordinary one.
 * 6. **A serial ratchet needs its skew bound.** `replayed` is only safe to
 *    produce alongside `deferred`. A verifier that remembers the highest
 *    serial but does not set aside future-dated ones can be jammed by a
 *    single forged record at a value nothing honest will exceed, and every
 *    genuine record thereafter reads as a replay. Shipping the memory
 *    without the bound is worse than shipping neither.
 * 7. **Do not invent a thirteenth value.** A status outside this set has no
 *    rendering and no agreed meaning.
 *
 * The errors this design tolerates run one way: it will not wrongly verify,
 * and it will sometimes fail to verify someone legitimate. Preserve that
 * asymmetry — it is what makes a badge worth trusting.
 *
 * ## What `verified` does NOT mean
 *
 * It is **not** the onomancy spec's *verified binding*, and the difference is
 * worth stating because the words are close enough to be read as the same
 * thing.
 *
 * The spec's binding runs through a certificate: the domain designates the
 * document whose id appears *in the certificate*, and a key delegated by
 * that document *signed* that certificate. This library consults no
 * certificate. It checks that DNS designates a document, and that the
 * identity is a delegated admin of it.
 *
 * Two consequences, and neither is merely "weaker evidence":
 *
 * 1. **It is not transferable.** A certificate is self-authenticating: anyone
 *    can check it against their own trust anchors, from bytes that arrived
 *    anywhere. This verdict is *local* — it needs the document replicated
 *    and keyhive state present, so a third party cannot be shown why the
 *    badge was earned.
 * 2. **The document is not a participant.** A domain may unilaterally name
 *    any document id, and that document's admins cannot decline. Under the
 *    spec the document *speaks*, and refusing to sign is how it declines.
 *    Here, the only thing preventing a badge is the identity not claiming
 *    the name in the first place.
 *
 * What consent there is comes from the claim, not from an artifact: the
 * badge renders only for entries that claimed a `dnsName`. So the identity
 * asserts the domain and DNS corroborates — mutual in a weak sense, and not
 * in the sense the spec means.
 *
 * **When certificates can be minted, do not overload this value.** There
 * will then be two verifiable claims of different strength, and one glyph
 * cannot carry both. The certificate-backed verdict wants its own status,
 * decided before it exists rather than after.
 */
export type DnsNameStatus =
  | "pending"
  | "verified"
  | "mismatch"
  | "contested"
  | "offline"
  | "malformed"
  | "no-claim"
  | "chain-failed"
  | "replayed"
  | "deferred"
  | "unsynced"
  | "invalid";

/** Display information for one keyhive identity. */
export interface DirectoryEntry {
  /** Hex-encoded keyhive identifier, as `listMembers` returns it. */
  id: string;
  name?: string;
  avatar?: Uint8Array | null;
  peerId?: string;
  /** Absent in entries written before directories recorded it. */
  kind?: DirectoryEntryKind;
  /**
   * JSON contact card, so someone found by name can be granted access without
   * needing to paste one in. Individuals only since a group has no card.
   */
  contactCard?: string;
  /**
   * A claimed DNS name, such as `expede.wtf`, stored without the `@` sigil.
   * Self-asserted until a verifying directory checks its `_onomancy` TXT
   * record. Empty string on publish clears the claim.
   */
  dnsName?: string;
  /**
   * Set by whatever verifies claims — `createOnomancyDirectory` from
   * `@inkandswitch/onomancy-react/onomancy`, or the application's own
   * equivalent. A decoration, never stored: directories strip it on
   * publish. Absent when the entry claims no DNS name, or when nothing in
   * scope verifies.
   *
   * Producers must follow the rules on {@link DnsNameStatus}.
   */
  dnsNameStatus?: DnsNameStatus;
  /**
   * How current the DNSSEC chain was when the claim was checked — `fresh`,
   * `stale`, or `deferred`. A decoration like `dnsNameStatus`, set by the
   * same verifier and never stored.
   *
   * **Orthogonal to the status, not a member of it.** "Verified, checked
   * just now" and "verified, but the proof lapsed a week ago" are the same
   * verdict at two confidences. Absent when no chain was obtained, which is
   * not the same as failing the axis.
   *
   * `stale` is a **risk signal, never a forgery signal** — a lapsed window
   * is what offline operation looks like. Render it as a passive qualifier
   * that still shows the binding; do not gate access on it and do not
   * interrupt for it. `deferred` means the window has not opened, nearly
   * always client clock skew: neither pass nor fail.
   */
  dnsNameFreshness?: "fresh" | "stale" | "deferred";
  /**
   * How far the chain had lapsed when checked, in seconds. Present only
   * beside a `stale` freshness, and only when the runtime supplied the
   * window it graded against.
   *
   * A proof that aged out an hour ago and one that aged out eight months
   * ago are both `stale`, and they do not warrant the same reaction. Like
   * the other `dnsName*` fields this is a decoration: computed per render,
   * never stored, stripped on publish.
   */
  dnsNameLapsedSeconds?: number;
}

export interface NameDirectory {
  /** Short identifier for the implementation, for example `"phonebook"`. */
  readonly source: string;
  readonly trust: DirectoryTrust;
  /** False when `publish` is absent. */
  readonly writable: boolean;
  /** False when entries can only be looked up by id, not listed. */
  readonly enumerable: boolean;
  /** One sentence about this directory's limits, rendered by the components. */
  readonly notice?: string;

  /** Synchronous, because it runs during render. */
  lookup(id: string): DirectoryEntry | undefined;

  /** Empty when `enumerable` is false. */
  list(): DirectoryEntry[];

  /** Present only when `writable`. */
  publish?(entry: DirectoryEntry): Promise<void> | void;

  /** Optional. For directories whose contents live outside React. */
  subscribe?(listener: () => void): () => void;
}

/** A directory that knows nothing. */
export const emptyDirectory: NameDirectory = {
  source: "empty",
  trust: "unverified",
  writable: false,
  enumerable: true,
  lookup: () => undefined,
  list: () => [],
};
