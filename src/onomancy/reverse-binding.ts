// The certificate half of DNS name verification, as a designation
// combinator. Promoted from the demo application once the flat-namestore
// migration landed; the verification itself stays injected, because it
// needs the bound documents (held replicas) and the onomancy Wasm, and
// this package imports nothing but React.

import type { DnsDesignation } from "./designation.js";

/**
 * What a bound document said about a hostname, when asked for its
 * certificate.
 *
 * - `accepted` — a certificate held in the document verified for this
 *   hostname (the application's check decides what "verified" requires,
 *   including any mutuality rule it applies).
 * - `rejected` — evidence arrived and failed: a certificate was held and
 *   did not verify.
 * - `absent` — the document holds no certificate for this hostname, or is
 *   not held here. Says nothing, in either direction.
 */
export type ReverseBindingClaim = "accepted" | "rejected" | "absent";

/**
 * Ask one designated document whether it accepts the hostname back.
 *
 * `documentId` is hex, as `HostnameBinding.ids` carries it. A typical
 * implementation reads the certificate list at the document's
 * `.well-known/onomancy/certificates` key and verifies through the
 * onomancy module (`verifyCertificate`/`verifyBinding`).
 */
export type ReverseBindingCheck = (
  documentId: string,
  hostname: string
) => Promise<ReverseBindingClaim>;

/**
 * Require the reverse half of a DNS binding: the zone names the document
 * (`p=`, the forward half the DNS layer proves), and the document names
 * the hostname back through an onomancy certificate signed by one of its
 * admin-delegated keys. The spec is explicit that a verified binding needs
 * both (dns-anchor, "A verified DNS binding proves exactly this"), and a
 * conforming verifier refuses when the reverse half is absent.
 *
 * `createKeyhiveDesignation` alone checks only that the identity
 * administers the designated document. That is necessary and not
 * sufficient: it shows the identity *could have* signed a certificate,
 * never that one exists. Reporting `designates` on it is not a weaker
 * claim than the spec's — it is a different one.
 *
 * So this composes the two and takes the weaker verdict:
 *
 * | inner says | certificate | result |
 * | --- | --- | --- |
 * | designates | accepted | `designates` |
 * | designates | absent | `unknown` — not proven, not disproven |
 * | designates | rejected | `excludes` — evidence arrived and failed |
 * | anything else | — | unchanged |
 *
 * Absence maps to `unknown` rather than `excludes` deliberately. A document
 * that carries no certificate has not *denied* the domain; it has said
 * nothing, and absence of evidence is not evidence of absence. A
 * certificate that arrived and failed verification is different in kind,
 * and that one does convict.
 *
 * Every bound document gets a chance: a domain mid-migration publishes
 * several, and only one need carry the certificate. One consequence of the
 * composition: an inner designation that grades a bare-key binding is
 * wrapped into `unknown` here, because a bare key holds no certificate.
 * That is correct — `p=` names a document.
 */
export function requireReverseBinding(
  check: ReverseBindingCheck,
  inner: DnsDesignation
): DnsDesignation {
  return async (entry, boundIds, hostname) => {
    const forward = await inner(entry, boundIds, hostname);
    if (forward !== "designates") return forward;

    let sawRejection = false;
    for (const id of boundIds) {
      const claim = await check(id, hostname);
      if (claim === "accepted") return "designates";
      if (claim === "rejected") sawRejection = true;
    }

    return sawRejection ? "excludes" : "unknown";
  };
}
