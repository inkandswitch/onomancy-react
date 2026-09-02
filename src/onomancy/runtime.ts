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
}

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
}

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
      return { hostname, ids: boundIdsOf(outcome) };
    },

    normalizeDnsName: (raw) => {
      const trimmed = raw.trim();
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

/** The hex-encoded `p=` document ids in a `resolveHostname` outcome. */
function boundIdsOf(outcome: unknown): string[] {
  if (typeof outcome !== "object" || outcome === null) return [];
  const records = (outcome as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  const ids: string[] = [];
  for (const record of records) {
    if (typeof record !== "string") continue;
    const id = parseRecordDocId(record);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * The hex-encoded root document id of one TXT record, or `undefined` when the
 * record is not a well-formed `v=ONO0` record. Parsing is strict within the
 * known tag, per the DNS anchoring spec: exact field order, known fields only.
 *
 * Hand-written on purpose: this is the TXT wire format, which `Name` does not
 * parse. `Name` decides what a *name* is; this decides what a *record* is.
 */
export function parseRecordDocId(record: string): string | undefined {
  const match = record.match(
    /^v=ONO0;k=ed25519;n=\d+;g=[A-Za-z0-9+/]+={0,2};p=([A-Za-z0-9+/]+={0,2})$/
  );
  if (!match) return undefined;
  const bytes = base64ToBytes(match[1]);
  if (bytes === undefined || bytes.length !== 32) return undefined;
  return bytesToHex(bytes);
}

function base64ToBytes(base64: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}
