// Namestore edge writes, promoted from the applications so the layout
// rules cannot drift between them.
//
// A namestore is a document's own flat top-level map (onomancy
// path-resolution spec, Namestore Layout): names are bare keys — possibly
// multi-segment, `todos/groceries` — whose values are bare `automerge:`
// references, sharing the map with protocol data, directory entries, and
// anything else whose value is not a reference (and is therefore absent
// from name matching by shape). Both consuming applications shipped a
// nested layout before reading that sentence carefully; these helpers
// carry the flat rules plus the migration-window cleanup of the legacy
// container.
//
// Deliberately pure over an already-open document: this package imports
// nothing but React, so finding the document and opening a change are the
// application's (`handle.change((doc) => bindEdge(doc, …))`), as is the
// substrate's scalar-string encoding, injected as `toReference`.

import { RESERVED_ONOMANCY_KEY } from "./automerge-directory.js";

/**
 * A change-proxied namestore document: the mutable view an Automerge
 * `change` callback receives. Values are the substrate's; these helpers
 * only ever assign what `toReference` returns and delete.
 */
export type NamestoreWriteDoc = Record<string, unknown>;

/**
 * Encode a target url as the substrate's scalar-string reference.
 *
 * Injected because the encoding is load-bearing and substrate-owned: a
 * plain JS string assigned into an Automerge map becomes a `Text` object,
 * which a conforming reader refuses (spliced merges can form a third value
 * nobody wrote), so an application passes its own wrapper — for Automerge,
 * `(url) => new ImmutableString(url)`.
 */
export type ToReference = (url: string) => unknown;

/**
 * Write one edge: `path` (segments joined by `/`) names `target` from this
 * document.
 *
 * Refuses reserved paths before touching the document, writes the flat
 * top-level key, and migrates its own path out of the legacy nested
 * container — the retired copy would otherwise linger and resurrect if the
 * flat edge were later unbound. Write paths may migrate; read paths stay
 * read paths.
 *
 * Segment hygiene is the caller's: parse the path through the onomancy
 * grammar (`Name`) before binding, so what is bound is exactly what
 * resolves.
 */
export function bindEdge(
  doc: NamestoreWriteDoc,
  path: string,
  target: string,
  toReference: ToReference
): void {
  refuseReservedPath(path);

  doc[path] = toReference(target);

  const legacy = doc[RESERVED_ONOMANCY_KEY];
  if (isContainer(legacy) && path in legacy) delete legacy[path];
}

/**
 * Remove one edge, which is how a name is unbound.
 *
 * Deletes from both layouts, so an unbind cannot resurrect a legacy edge
 * the flat one was shadowing. Guarded like {@link bindEdge}: unbinding the
 * certificate list's key would delete the certificate list.
 */
export function unbindEdge(doc: NamestoreWriteDoc, path: string): void {
  refuseReservedPath(path);

  delete doc[path];

  const legacy = doc[RESERVED_ONOMANCY_KEY];
  if (isContainer(legacy) && path in legacy) delete legacy[path];
}

/** Refusal to touch a name under a protocol-reserved prefix. */
export class ReservedPathError extends Error {
  constructor(path: string) {
    super(
      `"${path}" is reserved: paths under .well-known/ carry protocol data, not names`
    );
    this.name = "ReservedPathError";
  }
}

/**
 * The gate every namestore write path shares, exported so it can be tested
 * without a document: it must fire before anything is touched.
 *
 * The `.well-known/<owner>/` prefix carries protocol and application data
 * by the writers' convention the path-resolution spec assigns (onomancy's
 * certificate and decision lists among it). Resolvers apply no special rule
 * to the prefix — exclusion from matching is by value shape — but a WRITER
 * binding a name there replaces data another owner defines, while looking
 * like a successful bind. The whole prefix is refused, not just onomancy's
 * segment: owners are asserted rather than inherited, so a writer cannot
 * know which segments are claimed.
 */
export function refuseReservedPath(path: string): void {
  if (path === ".well-known" || path.startsWith(".well-known/")) {
    throw new ReservedPathError(path);
  }
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
