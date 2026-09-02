/** Whether a directory's names are self-asserted or proven. */
export type DirectoryTrust = "unverified" | "verified";

/** What an entry's id refers to. Groups are named here like individuals are. */
export type DirectoryEntryKind = "individual" | "group";

/**
 * Where a DNS name claim stands with a verifying directory.
 *
 * - `pending`: the claim is being resolved.
 * - `verified`: a DNSSEC-validated `_onomancy` TXT record designates this id.
 * - `mismatch`: the record designates a different id.
 * - `unreachable`: the binding could not be resolved (offline, no record, or
 *   an invalid chain), which proves nothing either way.
 * - `unsynced`: the domain designates a document this device has not synced,
 *   so membership cannot be checked yet. Also proves nothing either way.
 * - `invalid`: the claim is not a DNS name at all.
 *
 * ## Rules for anyone producing a status
 *
 * This library renders these six values; it does not require that it be the
 * thing that computes them. Applications that verify claims themselves must
 * follow the same rules, because the badge means the same thing to a reader
 * whichever code produced it.
 *
 * 1. **`mismatch` requires a record that designates somebody.** A hostname
 *    that resolves and DNSSEC-validates but whose records all fail strict
 *    `v=ONO0` parsing proves nothing about any identity, so it is
 *    `unreachable`. This is not hypothetical: a live record was once a
 *    hex-encoded `g=` field followed by a truncated `p=`, and every parse
 *    rejected. Reporting that as `mismatch` would accuse the claimant on
 *    the strength of somebody's typo.
 * 2. **`unreachable` and `unsynced` are the absence of an answer**, never a
 *    weak `mismatch`. Do not collapse them into it, and do not collapse
 *    them into each other: the first means the DNS layer said nothing, the
 *    second that it spoke and the local device cannot yet check the reply.
 * 3. **`verified` requires positive evidence**, never the absence of
 *    contrary evidence.
 * 4. **Do not invent a seventh value.** A status outside this set has no
 *    rendering and no agreed meaning.
 *
 * The errors this design tolerates run one way: it will not wrongly verify,
 * and it will sometimes fail to verify someone legitimate. Preserve that
 * asymmetry — it is what makes a badge worth trusting.
 */
export type DnsNameStatus =
  "pending" | "verified" | "mismatch" | "unreachable" | "unsynced" | "invalid";

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
   * `@automerge/keyhive-react/onomancy`, or the application's own
   * equivalent. A decoration, never stored: directories strip it on
   * publish. Absent when the entry claims no DNS name, or when nothing in
   * scope verifies.
   *
   * Producers must follow the rules on {@link DnsNameStatus}.
   */
  dnsNameStatus?: DnsNameStatus;
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
