import type {
  DirectoryEntry,
  DirectoryEntryKind,
  DirectoryTrust,
  NameDirectory,
} from "./types.js";

/**
 * The reserved top-level key onomancy namestore data lives under when the
 * directory document doubles as a root namestore. Never a directory entry:
 * profile entries and namestore edges share the document without colliding.
 *
 * Co-location is a layout choice, not a requirement, and the choice is
 * constrained by where the document's id came from. Only a self-certifying
 * ed25519 document id can anchor a domain — onomancy rejects a legacy
 * 16-byte Automerge id outright — so a directory document created through
 * `repo.create2` can host both profile entries and namestore edges, while
 * one carrying a legacy id can never be a `p=` target and needs the
 * namestore kept separately. This filtering is correct either way: it costs
 * nothing under the separate layout and is load-bearing under the shared
 * one.
 */
export const RESERVED_ONOMANCY_KEY = "onomancy";

/** Hex-encoded keyhive id to display information. */
export type DirectoryDoc = Record<
  string,
  {
    peerId?: string;
    name?: string;
    avatar?: Uint8Array | null;
    kind?: DirectoryEntryKind;
    contactCard?: string;
    dnsName?: string;
  }
>;

/** The `changeDoc` half of `useDocument`. */
export type DirectoryDocChange = (updater: (doc: DirectoryDoc) => void) => void;

export interface AutomergeDocDirectoryOptions {
  source?: string;
  trust?: DirectoryTrust;
  notice?: string;
}

const DEFAULT_NOTICE =
  "Names come from a shared document that anyone with its id can edit. They are not verified.";

/**
 * Whether a top-level key may name a directory entry.
 *
 * The flat namestore layout puts names, protocol data, and directory
 * entries in one shared top-level map, so what is NOT an entry id is
 * decided here once for the read paths and the publish guard together:
 * the `.well-known/` prefix (a writers' convention with asserted owners),
 * and the legacy `onomancy` container during its migration window.
 */
function isEntryId(id: string): boolean {
  return (
    id !== RESERVED_ONOMANCY_KEY &&
    id !== ".well-known" &&
    !id.startsWith(".well-known/")
  );
}

/**
 * Whether a top-level value is a directory entry, by shape.
 *
 * The same shared map holds namestore edges (scalar-string wrappers,
 * which arrive as objects carrying their text in `val`), certificate
 * lists (arrays), and byte payloads — none of which is an entry, and a
 * spread of one would mint a junk row. Shape, not key: names are bare
 * keys, so no key list can enumerate what to skip.
 */
function isEntryRecord(value: unknown): value is DirectoryDoc[string] {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !("val" in value)
  );
}

/**
 * A directory backed by a single Automerge document, where each peer writes its
 * own entry. Build it with `useAutomergeDocDirectory`.
 */
export function createAutomergeDocDirectory(
  doc: DirectoryDoc | undefined,
  change: DirectoryDocChange | undefined,
  options: AutomergeDocDirectoryOptions = {}
): NameDirectory {
  const directory: NameDirectory = {
    source: options.source ?? "automerge-doc",
    // An unsigned document is only as trustworthy as everyone who can write it.
    trust: options.trust ?? "unverified",
    writable: change !== undefined,
    enumerable: true,
    notice: options.notice ?? DEFAULT_NOTICE,

    lookup(id) {
      if (!isEntryId(id)) return undefined;
      const record = doc?.[id];
      return isEntryRecord(record) ? { id, ...record } : undefined;
    },

    list() {
      if (!doc) return [];
      return Object.entries(doc)
        .filter(
          (pair): pair is [string, DirectoryDoc[string]] =>
            isEntryId(pair[0]) && isEntryRecord(pair[1])
        )
        .map(([id, record]) => ({ id, ...record }));
    },
  };

  if (change) {
    directory.publish = (entry: DirectoryEntry) => {
      // Refused loudly. `lookup` and `list` filter these keys, so an
      // unguarded write succeeds and then becomes unreadable — and it lands
      // in a region another owner defines: `.well-known/<owner>/` carries
      // protocol and application data by the writers' convention the
      // path-resolution spec assigns (onomancy's certificate list among it,
      // where whoever can write can remove or replace certificates — a
      // capability the spec reserves to admin-delegated keys; dns-anchor.md
      // §In the Bound Document). The legacy `onomancy` container is guarded
      // for the same reason during its migration window. Throwing rather
      // than dropping, because a silent no-op is indistinguishable from a
      // write that worked when the read paths hide it either way.
      if (!isEntryId(entry.id)) {
        throw new Error(
          `"${entry.id}" is reserved for protocol data and cannot be used as a directory entry id.`
        );
      }

      change((d) => {
        const existing = d[entry.id];
        if (!existing) {
          // Assigning undefined into an Automerge document throws.
          const record: DirectoryDoc[string] = {};
          if (entry.peerId !== undefined) record.peerId = entry.peerId;
          if (entry.name !== undefined) record.name = entry.name;
          if (entry.avatar !== undefined) record.avatar = entry.avatar ?? null;
          if (entry.kind !== undefined) record.kind = entry.kind;
          if (entry.contactCard !== undefined)
            record.contactCard = entry.contactCard;
          if (entry.dnsName) record.dnsName = entry.dnsName;
          d[entry.id] = record;
          return;
        }
        // Field by field, so concurrent writes merge.
        if (entry.peerId !== undefined) existing.peerId = entry.peerId;
        if (entry.name !== undefined) existing.name = entry.name;
        if (entry.avatar !== undefined) existing.avatar = entry.avatar ?? null;
        if (entry.kind !== undefined) existing.kind = entry.kind;
        if (entry.contactCard !== undefined)
          existing.contactCard = entry.contactCard;
        // The empty string clears a claim; undefined leaves it alone.
        if (entry.dnsName !== undefined) {
          if (entry.dnsName === "") delete existing.dnsName;
          else existing.dnsName = entry.dnsName;
        }
      });
    };
  }

  return directory;
}
