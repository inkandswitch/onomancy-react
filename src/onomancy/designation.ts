import type { AutomergeRepoKeyhiveBase } from "@automerge/automerge-repo-keyhive";
import { bytesToHex, hexToBytes } from "../bytes.js";
import type { DirectoryEntry } from "../directory/types.js";
import type { KeyhiveRuntime } from "../runtime.js";

/**
 * Whether a DNS binding's root documents designate an identity.
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
 */
export const idEqualityDesignation: DnsDesignation = (entry, boundIds) =>
  boundIds.includes(bareId(entry.id)) ? "designates" : "excludes";

export interface KeyhiveDesignationOptions {
  /**
   * The least access that counts as the domain designating someone, as
   * `Access.fromString` accepts it. Admin by default: controlling the root
   * namestore document is what owning the name means.
   */
  minimumAccess?: string;
}

/**
 * Designation through keyhive: the domain binds a root namestore document,
 * and the identities the document delegates admin access to are the ones it
 * designates. Ownership is shared by inviting more admins; the DNS record
 * never changes.
 *
 * The solo case is included: a bound id that is the identity itself
 * designates directly, so anchors of either shape verify.
 *
 * Only the document's own delegations are consulted, so an identity holding
 * admin through a nested group is `unknown` here, not excluded. A document
 * this device has not synced is `unknown` too.
 */
export function createKeyhiveDesignation(
  runtime: KeyhiveRuntime,
  hive: AutomergeRepoKeyhiveBase,
  options: KeyhiveDesignationOptions = {}
): DnsDesignation {
  const level = options.minimumAccess ?? "admin";

  return async (entry, boundIds) => {
    const entryId = bareId(entry.id);
    if (boundIds.includes(entryId)) return "designates";

    const minimum = runtime.Access.fromString(level);
    let anyHeld = false;
    let anyDirectMember = false;

    for (const boundId of boundIds) {
      const document = await hive.keyhive.getDocument(
        new runtime.DocumentId(hexToBytes(boundId))
      );
      if (!document) continue;
      anyHeld = true;

      for (const capability of await document.members()) {
        const memberId = bytesToHex(capability.who.id.toBytes());
        if (memberId !== entryId) continue;
        anyDirectMember = true;
        if (capability.can.atLeast(minimum)) return "designates";
      }
    }

    // Only a direct delegation below the minimum excludes. An unheld
    // document proves nothing, and neither does absence from the direct
    // members: access may route through a group this check does not walk.
    return anyHeld && anyDirectMember ? "excludes" : "unknown";
  };
}

function bareId(id: string): string {
  return (id.startsWith("0x") ? id.slice(2) : id).toLowerCase();
}
