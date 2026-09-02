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
 * The solo case: the bound id is the identity itself. This is the default,
 * and the right check when accounts anchor domains directly to their key.
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
 * The solo case is included: a bound id that is the identity itself
 * designates directly, so anchors of either shape verify.
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
    // The domain may anchor the key directly rather than a document.
    if (boundIds.map(bareId).includes(identityId)) return "designates";

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
