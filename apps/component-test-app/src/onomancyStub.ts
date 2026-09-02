import * as onomancy from "@inkandswitch/onomancy";
import type { OnomancyModule } from "@automerge/keyhive-react";

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
    resolveHostname(hostname: string, dohUrl?: string | null) {
      if (!hostname.endsWith(".test")) {
        return onomancy.resolveHostname(hostname, dohUrl);
      }
      switch (hostname) {
        case "self.test":
          return Promise.resolve(outcome(hostname, selfIdHex));
        case "other.test":
          return Promise.resolve(outcome(hostname, "ab".repeat(32)));
        default:
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
