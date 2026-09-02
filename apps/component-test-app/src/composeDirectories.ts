import type { DirectoryEntry, NameDirectory } from "@automerge/keyhive-react";

function definedFields(entry: DirectoryEntry): DirectoryEntry {
  const out = { ...entry };
  for (const key of Object.keys(out) as (keyof DirectoryEntry)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function mergeEntries(
  primary: DirectoryEntry | undefined,
  fallback: DirectoryEntry | undefined
): DirectoryEntry | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return { ...fallback, ...definedFields(primary) };
}

/**
 * One directory over two: reads prefer `primary` field by field, writes go to
 * both. Here the primary is the shared directory document and the fallback is
 * the localStorage copy, so names survive offline and sync when they can.
 */
export function composeDirectories(
  primary: NameDirectory,
  fallback: NameDirectory
): NameDirectory {
  return {
    source: `${primary.source}+${fallback.source}`,
    trust: "unverified",
    writable: primary.writable || fallback.writable,
    enumerable: true,
    notice: primary.notice ?? fallback.notice,

    lookup(id) {
      return mergeEntries(primary.lookup(id), fallback.lookup(id));
    },

    list() {
      const byId = new Map<string, DirectoryEntry>();
      for (const entry of fallback.list()) byId.set(entry.id, entry);
      for (const entry of primary.list()) {
        const merged = mergeEntries(entry, byId.get(entry.id));
        if (merged) byId.set(entry.id, merged);
      }
      return [...byId.values()];
    },

    async publish(entry) {
      if (primary.publish) await primary.publish(entry);
      if (fallback.publish) await fallback.publish(entry);
    },

    subscribe(listener) {
      // Fresh closures, not the raw listener: a child directory that
      // deduplicates listeners by identity would collapse two subscriptions
      // sharing one callback, and the first unsubscribe would cancel the
      // second subscriber's updates.
      const subscriptions = [
        primary.subscribe?.(() => listener()),
        fallback.subscribe?.(() => listener()),
      ];
      return () => {
        for (const unsubscribe of subscriptions) unsubscribe?.();
      };
    },
  };
}
