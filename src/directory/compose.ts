// Field-wise composition of two directories: layering by trust and
// provenance, one set of merge rules to reason about. The motivating
// consumer is the demo's naming trust ladder — petnames over verified
// self-profiles over a shared phonebook — where each layer is written by
// someone with a different right to it and the reader wants the most
// trusted value per FIELD, not per entry.
//
// Not a cache. A directory backed by an Automerge document already has an
// offline story — its local replica — and composing a second store over it
// only shadows the shared one with writes nobody else receives.

import type { DirectoryEntry, NameDirectory } from "./types.js";

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
 * One directory over two: reads prefer `primary` field by field, writes go
 * to both. A typical pairing puts the more trusted source first — your own
 * labels over a shared document, a verified layer over an unverified one —
 * so a missing field falls through without the whole entry losing its
 * better name.
 *
 * Trust is the floor, not the ceiling: the composition reports
 * `unverified`, because a merged entry may carry fields from either side
 * and the read path cannot attribute them.
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
      // Both writes are attempted regardless of the first's outcome, and
      // failures surface together: losing the local copy because the shared
      // write rejected would trade durability for tidiness.
      const outcomes = await Promise.allSettled([
        primary.publish?.(entry),
        fallback.publish?.(entry),
      ]);
      const failures = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected"
      );
      // Rethrown only after both writes were attempted: the caller learns
      // the publish did not fully land, without the surviving write having
      // been skipped on the way.
      if (failures.length > 0) throw failures[0]!.reason;
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
