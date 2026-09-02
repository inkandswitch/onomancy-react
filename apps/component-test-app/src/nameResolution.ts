import {
  isValidAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/react/slim";
import { hexToBytes, RESERVED_ONOMANCY_KEY } from "@automerge/keyhive-react";
import type { OnomancyRuntime } from "@automerge/keyhive-react/onomancy";

/**
 * The path-resolution walk over locally held documents, per the onomancy
 * path-resolution spec: greedy longest-key matching against the flat
 * namestore map under the reserved key, one hop per matched edge, no
 * backtracking. Partial outcomes are the designed norm under partition,
 * not errors.
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
  let rest = raw.trim();
  const root: ParsedLookup["root"] = "self";

  if (rest.startsWith("@")) {
    const [hostname, ...segments] = rest.slice(1).split("/");
    if (!hostname || !hostname.includes(".")) {
      throw new Error(`Not a DNS name: "@${hostname}"`);
    }
    return { root: { hostname: hostname.toLowerCase() }, segments };
  }

  if (rest.startsWith("automerge:")) {
    const [anchor, ...segments] = rest.split("/");
    if (!isValidAutomergeUrl(anchor)) {
      throw new Error(`Not a document anchor: "${anchor}"`);
    }
    return { root: { url: anchor }, segments };
  }

  if (rest === "~") return { root, segments: [] };
  if (rest.startsWith("~/")) rest = rest.slice(2);
  if (rest === "") return { root, segments: [] };
  return { root, segments: rest.split("/") };
}

/** The Automerge URL for a hex-encoded 32-byte document id. */
export function urlFromDocIdHex(hex: string): AutomergeUrl {
  return stringifyAutomergeUrl(
    hexToBytes(hex) as Parameters<typeof stringifyAutomergeUrl>[0]
  );
}

/** Segment hygiene per the name grammar: reject rather than normalize. */
export function checkSegments(segments: string[]): void {
  for (const segment of segments) {
    if (segment === "") throw new Error("Empty segment.");
    if (segment === "." || segment === "..") {
      throw new Error("No traversal segments.");
    }
    if (/[#/\p{Cc}]/u.test(segment)) {
      throw new Error(`Invalid segment: "${segment}"`);
    }
  }
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
  const map = (doc as Record<string, unknown>)[RESERVED_ONOMANCY_KEY];
  if (typeof map !== "object" || map === null) return {};

  const edges: Record<string, AutomergeUrl> = {};
  for (const [key, value] of Object.entries(map)) {
    // Bare references only: anything else is absent (E5), and malformed
    // keys never match already-valid segments (E6).
    if (typeof value === "string" && isValidAutomergeUrl(value)) {
      edges[key] = value;
    }
  }
  return edges;
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

/** Resolve segments from a root document. No backtracking, live reads. */
export async function resolvePath(
  repo: Repo,
  root: AutomergeUrl,
  segments: string[]
): Promise<Resolution> {
  checkSegments(segments);

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
