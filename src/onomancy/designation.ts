import type { AutomergeRepoKeyhiveBase } from "@automerge/automerge-repo-keyhive";
import {
  bareId,
  documentDelegatesTo,
  type DocumentDelegationOptions,
} from "../access/delegation.js";
import type { DirectoryEntry } from "../directory/types.js";
import type { KeyhiveRuntime } from "../runtime.js";

/**
 * Whether a DNS binding's root documents designate an identity.
 *
 * Deliberately *not* the same type as `DelegationVerdict`, though both have
 * three values. `excludes` here means the domain designates somebody else,
 * which is a different fact from a delegation existing below the required
 * level — and the two collapse into one only at this boundary, where every
 * keyhive reason for "not them" becomes the single DNS answer "not them".
 *
 * `unknown` is for verdicts the local device cannot reach: the designated
 * document exists but is not held here, so membership can be checked only
 * after a sync. It is not evidence in either direction.
 */
export type DesignationVerdict = "designates" | "excludes" | "unknown";

/**
 * The authority half of DNS name verification. The DNS layer proves
 * `hostname → root document ids`; a designation decides whether those
 * documents belong to the entry's identity.
 */
export type DnsDesignation = (
  entry: DirectoryEntry,
  boundIds: string[],
  hostname: string
) => Promise<DesignationVerdict> | DesignationVerdict;

/**
 * Plain id equality: the bound id is the identity itself.
 *
 * **Not a conformant production check**, and deliberately not the default for
 * keyhive documents. The onomancy spec is unambiguous that `p=` names a
 * *document*:
 *
 * > `p` MUST be the base64 encoding of the 32-byte root document ID (an
 * > ed25519 verifying key) — *specs/anchoring/dns-anchor.md:72*
 *
 * and that a bare key is not an identity at all:
 *
 * > the key alone is not an identity, since the same key bytes may be
 * > delegated in more than one document — *dns-anchor.md:144*
 *
 * So a `p=` naming an individual is a configuration the spec does not
 * define, and this function grades it `designates` anyway. That is fine for
 * a **stub or a test**, where the point is a deterministic outcome with no
 * keyhive documents behind it, and wrong for anything a person reads as
 * proof: there is no document, so there can be no certificate, so no third
 * party can be shown why the verdict was reached.
 *
 * Use {@link createKeyhiveDesignation} for real bindings.
 *
 * A bound id that is somebody else's `excludes`, because a record naming a
 * different identity is a positive statement about who the domain means.
 */
export const idEqualityDesignation: DnsDesignation = (entry, boundIds) =>
  boundIds.map(bareId).includes(bareId(entry.id)) ? "designates" : "excludes";

export type KeyhiveDesignationOptions = DocumentDelegationOptions;

/**
 * Designation through keyhive: the domain binds a root namestore document,
 * and the identities that document delegates admin access to are the ones it
 * designates. Ownership is shared by inviting more admins; the DNS record
 * never changes.
 *
 * A composition, not an implementation. The DNS half is here; the keyhive
 * half is {@link documentDelegatesTo}, which knows nothing about domains.
 *
 * **No solo short-circuit.** An earlier version accepted a `p=` that named
 * the identity's own key directly, on the reading that a "solo publisher"
 * may anchor to their key. That conflated two different uses of the word:
 * the spec's solo allowance is about **`g=`**, permitting a solo publisher's
 * *generation key* to be their own admin key (`doc → admin`, the chain
 * trivially passing through) — it is not permission for `p=` to skip the
 * document.
 *
 * A `p=` naming an individual therefore reaches `documentDelegatesTo`, finds
 * no document under that id, and grades `unknown`: not refuted, not proven.
 * Which is what it is — a bare key can carry no certificate, so nothing about
 * it is checkable by anyone but the verifier that computed it.
 *
 * Inherits {@link documentDelegatesTo}'s limit — an identity holding admin
 * through a nested group reads `unknown`, never `excludes`.
 */
export function createKeyhiveDesignation(
  runtime: KeyhiveRuntime,
  hive: AutomergeRepoKeyhiveBase,
  options: KeyhiveDesignationOptions = {}
): DnsDesignation {
  return async (entry, boundIds) => {
    const identityId = bareId(entry.id);

    const verdict = await documentDelegatesTo(
      runtime,
      hive,
      boundIds,
      identityId,
      options
    );

    // Every keyhive reason for "not them" is the one DNS answer "not them";
    // "no answer" stays "no answer" across the boundary.
    switch (verdict) {
      case "delegates":
        return "designates";
      case "insufficient":
        return "excludes";
      default:
        return "unknown";
    }
  };
}
