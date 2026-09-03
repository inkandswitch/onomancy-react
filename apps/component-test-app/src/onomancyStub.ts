import * as onomancy from "@inkandswitch/onomancy";
import type { OnomancyModule } from "@inkandswitch/onomancy-react/onomancy";

/**
 * Real onomancy for real domains; deterministic outcomes under `.test`, so
 * the e2e tests need neither a network nor real domains. A real application
 * imports the package and hands it to `createOnomancyRuntime` unchanged.
 *
 * - `self.test` resolves to the local identity: a claim of it verifies.
 * - `other.test` resolves to a different identity: a claim of it mismatches.
 * - Other `.test` names reject, as an unreachable or unbound domain would.
 * - Everything else goes to `@inkandswitch/onomancy`: DoH plus DNSSEC
 *   validation from the IANA root, inside the Wasm.
 */
export function createStubOnomancy(selfIdHex: string): OnomancyModule {
  return {
    // The grammar is never stubbed: `.test` hostnames are ordinary DNS
    // names, so parsing them is the real parser's job either way. The same
    // goes for the RRset rules and the anchor decoder — the fabricated
    // `.test` records are grammatical, so the real classifier judges them,
    // and only resolution itself is ever faked.
    Name: onomancy.Name,
    classifyRecords: onomancy.classifyRecords,
    docAnchorBytes: onomancy.docAnchorBytes,

    resolveHostname(hostname: string, dohUrl?: string | null) {
      if (!hostname.endsWith(".test")) {
        return onomancy.resolveHostname(hostname, dohUrl);
      }
      switch (hostname) {
        case "self.test":
          return Promise.resolve(outcome(hostname, selfIdHex));
        case "other.test":
          // A valid curve point that is not the local identity: fill(0x03)
          // is in the conformance vectors' point-validity table. fill bytes
          // are NOT points in general (~half the byte space is not), and a
          // non-point p= makes the whole record malformed — which reads as
          // "publishes no usable record", not as a mismatch.
          return Promise.resolve(outcome(hostname, "03".repeat(32)));
        default:
          // A plain Error with no `reason` property: the directory's
          // conservative fallback maps it to `offline`, and the e2e
          // assertions depend on that. Adding a typed reason here changes
          // which status renders.
          return Promise.reject(
            new Error(`No onomancy binding for ${hostname}`)
          );
      }
    },
  };
}

function outcome(hostname: string, boundIdHex: string) {
  const generationKey = hexToBase64("00".repeat(32));
  return {
    hostname,
    links: [],
    freshness: "fresh",
    records: [
      `v=ONO0;k=ed25519;n=1;g=${generationKey};p=${hexToBase64(boundIdHex)}`,
    ],
  };
}

function hexToBase64(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
}
