import { bytesToHex } from "../bytes.js";

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
}

/** Build a runtime from the application's own onomancy import. */
export function createOnomancyRuntime(
  onomancy: OnomancyModule,
  options: OnomancyRuntimeOptions = {}
): OnomancyRuntime {
  return {
    async resolveBoundIds(hostname) {
      const outcome = await onomancy.resolveHostname(
        hostname,
        options.dohUrl ?? null
      );
      return { hostname, ids: boundIdsOf(outcome) };
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

/**
 * Parse a claimed DNS name into its canonical form: lowercase, leading `@`
 * and trailing dot stripped. Throws on names the DNS anchoring grammar
 * rejects, such as dotless names and IP literals.
 */
export function normalizeDnsName(raw: string): string {
  let name = raw.trim().toLowerCase();
  if (name.startsWith("@")) name = name.slice(1);
  if (name.endsWith(".")) name = name.slice(0, -1);

  if (name.length === 0 || name.length > 253) {
    throw new Error(`Not a DNS name: "${raw}"`);
  }
  const labels = name.split(".");
  // A dotless name is a flat parse error, never a hostname.
  if (labels.length < 2) {
    throw new Error(`A DNS name needs at least one dot: "${raw}"`);
  }
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63) {
      throw new Error(`Not a DNS label: "${label}" in "${raw}"`);
    }
  }
  // IP literals are rejected under `@`.
  if (labels.every((label) => /^\d+$/.test(label))) {
    throw new Error(`IP literals cannot be onomancy names: "${raw}"`);
  }
  return name;
}
