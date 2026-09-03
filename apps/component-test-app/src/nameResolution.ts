import {
  isImmutableString,
  isValidAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/react/slim";
import { Name } from "@inkandswitch/onomancy";
import {
  hexToBytes,
  RESERVED_ONOMANCY_KEY,
} from "@inkandswitch/onomancy-react";
import type { OnomancyRuntime } from "@inkandswitch/onomancy-react/onomancy";

/**
 * The path-resolution walk over locally held documents, per the onomancy
 * path-resolution spec: greedy longest-key matching against the document's
 * own flat top-level map, one hop per matched edge, no backtracking.
 * Partial outcomes are the designed norm under partition, not errors.
 */

export type Resolution =
  | { status: "resolved"; url: AutomergeUrl }
  | {
      status: "partial";
      consumed: number;
      total: number;
      reason: "unsynced-target" | "dangling-segment";
      /** The document the walk stopped at (hold or sync it and retry). */
      at: AutomergeUrl;
    };

/** A parsed lookup: where the walk starts and the segments to consume. */
export interface ParsedLookup {
  root: "self" | { hostname: string } | { url: AutomergeUrl };
  segments: string[];
}

/**
 * Parse a name into its anchor family and segments, per the name grammar's
 * disjoint leading tokens: `~` (and, as a convenience, bare paths) root at
 * our own directory document, `@hostname` at whatever the DNS binding
 * designates, and `automerge:` at the document itself. Whatever the anchor,
 * the walk after it is identical.
 */
export function parseLookup(raw: string): ParsedLookup {
  const trimmed = raw.trim();
  if (trimmed === "") return { root: "self", segments: [] };

  // A sigil-less string is read as a local name, as a typing convenience;
  // everything after that convenience is the grammar's. Parsing through
  // onomancy's own `Name` — the same code that decides names everywhere
  // else — is what keeps this app from drifting: canonicalization, dotless
  // names, IP literals, label and segment rules all come from one place.
  // (The stub never fakes the grammar either; only resolution is faked.)
  const spelled =
    trimmed.startsWith("~") ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("automerge:")
      ? trimmed
      : `~/${trimmed}`;

  const name = new Name(spelled);
  try {
    const segments = [...name.segments];
    switch (name.anchorKind) {
      case "local":
        return { root: "self", segments };
      case "dns":
        // Printed with its sigil; the hostname is what DNS is asked about.
        return { root: { hostname: name.anchor.slice(1) }, segments };
      case "doc":
        return { root: { url: name.anchor as AutomergeUrl }, segments };
      default:
        // The grammar has exactly three anchor kinds. A fourth means this
        // app and its onomancy disagree about the name grammar.
        throw new Error(`Unknown anchor kind: "${name.anchorKind}"`);
    }
  } finally {
    name.free();
  }
}

/** The Automerge URL for a hex-encoded 32-byte document id. */
export function urlFromDocIdHex(hex: string): AutomergeUrl {
  return stringifyAutomergeUrl(
    hexToBytes(hex) as Parameters<typeof stringifyAutomergeUrl>[0]
  );
}

/** The namestore edges of one held document, malformed values absent. */
async function namestoreOf(
  repo: Repo,
  url: AutomergeUrl
): Promise<Record<string, AutomergeUrl> | undefined> {
  let doc: unknown;
  try {
    const handle = await repo.find(url);
    doc = handle.doc();
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;

  // The document's own top-level map IS the namestore (flat layout). Bare
  // references only: anything else is absent (E5) — which is also what
  // keeps directory entries, certificate lists, and other protocol data
  // out of the walk without any key registry — and malformed keys never
  // match already-valid segments (E6).
  const edges: Record<string, AutomergeUrl> = {};
  for (const [key, value] of Object.entries(doc)) {
    const target = edgeUrlOf(value);
    if (target !== undefined) edges[key] = target;
  }

  // The legacy nested layout, resolved as a fallback during the migration
  // window: a flat edge shadows a nested one at the same path, rebinding
  // migrates a path for free, and the branch's removal condition is that
  // no namestore in use still holds a nested edge — the log keeps such
  // documents visible.
  const legacy = (doc as Record<string, unknown>)[RESERVED_ONOMANCY_KEY];
  if (typeof legacy === "object" && legacy !== null) {
    const inherited: string[] = [];
    for (const [key, value] of Object.entries(legacy)) {
      const target = edgeUrlOf(value);
      if (target !== undefined && !(key in edges)) {
        edges[key] = target;
        inherited.push(key);
      }
    }
    if (inherited.length > 0) {
      console.warn(
        `onomancy: ${url} still resolves ${inherited.length} edge(s) from the legacy nested layout (${inherited.join(
          ", "
        )}); rebind them or migrate — conforming resolvers cannot see them`
      );
    }
  }
  return edges;
}

/**
 * The reference a namestore value carries, or `undefined` when the value
 * is not one (E5/E8).
 *
 * Scalar strings (`ImmutableString`, the only encoding a conforming
 * reader matches) and plain JS strings — this app's own pre-migration
 * writes, which Automerge stored as `Text`. The `Text` branch is a
 * KNOWING leniency bounded by behaviour rather than structure (neither
 * app splices edge values); it keeps old edges resolving through the
 * migration window and shares the legacy branch's removal condition.
 */
function edgeUrlOf(value: unknown): AutomergeUrl | undefined {
  const text = isImmutableString(value)
    ? value.val
    : typeof value === "string"
      ? value
      : undefined;
  return text !== undefined && isValidAutomergeUrl(text) ? text : undefined;
}

/** Greedy longest-key match: the most segments, at segment boundaries. */
function longestMatch(
  edges: Record<string, AutomergeUrl>,
  segments: string[]
): { key: string; length: number } | undefined {
  let best: { key: string; length: number } | undefined;
  for (const key of Object.keys(edges)) {
    const parts = key.split("/");
    if (parts.length > segments.length) continue;
    if (!parts.every((part, i) => part === segments[i])) continue;
    if (!best || parts.length > best.length) {
      best = { key, length: parts.length };
    }
  }
  return best;
}

/**
 * Resolve segments from a root document. No backtracking, live reads.
 * Segment hygiene is `parseLookup`'s (the grammar's): every caller's
 * segments come out of a parsed name.
 */
export async function resolvePath(
  repo: Repo,
  root: AutomergeUrl,
  segments: string[]
): Promise<Resolution> {
  let current = root;
  let consumed = 0;
  const total = segments.length;
  let remaining = segments;

  while (remaining.length > 0) {
    const edges = await namestoreOf(repo, current);
    if (edges === undefined) {
      return {
        status: "partial",
        consumed,
        total,
        reason: "unsynced-target",
        at: current,
      };
    }

    const match = longestMatch(edges, remaining);
    if (!match) {
      return {
        status: "partial",
        consumed,
        total,
        reason: "dangling-segment",
        at: current,
      };
    }

    current = edges[match.key];
    consumed += match.length;
    remaining = remaining.slice(match.length);
  }

  return { status: "resolved", url: current };
}

/**
 * Resolve a full lookup. A `@hostname` root goes through the onomancy
 * runtime (DNSSEC-validated TXT record) to the bound root document; `~` and
 * bare paths start from our own directory document.
 */
export async function resolveLookup(
  repo: Repo,
  runtime: OnomancyRuntime,
  selfRoot: AutomergeUrl,
  raw: string
): Promise<Resolution> {
  const { root, segments } = parseLookup(raw);

  const rootUrl =
    root === "self"
      ? selfRoot
      : "url" in root
        ? root.url
        : await hostnameRoot(runtime, root.hostname);
  return resolvePath(repo, rootUrl, segments);
}

/** The root document a hostname's DNS binding designates. */
export async function hostnameRoot(
  runtime: OnomancyRuntime,
  hostname: string
): Promise<AutomergeUrl> {
  const binding = await runtime.resolveBoundIds(hostname);
  const [boundId] = binding.ids;
  if (boundId === undefined) {
    throw new Error(`No usable onomancy binding for ${hostname}.`);
  }
  return urlFromDocIdHex(boundId);
}
