import type { AutomergeRepoKeyhiveBase } from "@automerge/automerge-repo-keyhive";
import { bytesToHex, hexToBytes } from "../bytes.js";
import type { KeyhiveRuntime } from "../runtime.js";

/**
 * Whether documents delegate to an identity at a required level.
 *
 * The three values are deliberately not two. `insufficient` is reachable
 * only when a delegation naming the identity was found and every one fell
 * below the minimum, so it can never mean "not a member" — though it reads
 * that way if you skim it. Everything else that is not a clear yes is
 * `unknown`: a document this device has not synced, and an identity whose
 * access routes through a group, are both the absence of an answer rather
 * than a negative one.
 *
 * Collapsing `unknown` into `insufficient` is the same error as reporting a
 * DNS name that could not be resolved as a mismatch. Absence of evidence is
 * not evidence of absence.
 */
export type DelegationVerdict = "delegates" | "insufficient" | "unknown";

export interface DocumentDelegationOptions {
  /**
   * The least access that counts, as `Access.fromString` accepts it. Admin
   * by default: controlling a document is what owning it means.
   */
  minimumAccess?: string;
}

/**
 * Does any of these documents delegate to this identity at `minimumAccess`?
 *
 * A plain question about keyhive documents and keyhive identities: no DNS,
 * no directory, no presentation. Callers compose it into whatever larger
 * question they are asking — including DNS name verification, where the
 * documents come from a domain's `_onomancy` record.
 *
 * Only each document's own delegations are consulted. An identity holding
 * access through a nested group is `unknown`, not `insufficient`, because
 * keyhive's `members()` reports a document's own delegations and those do
 * not change when a group that already has access gains a member. Resolving
 * that needs transitive delegations *with* their capabilities, which no
 * current API exposes: `cgkaMembers()` returns bare `Identifier`s, and
 * `Identifier` carries no access level at all.
 *
 * @example
 * ```ts
 * const verdict = await documentDelegatesTo(runtime, hive, [docId], userId);
 * if (verdict === "delegates") grantSomething();
 * ```
 */
export async function documentDelegatesTo(
  runtime: KeyhiveRuntime,
  hive: AutomergeRepoKeyhiveBase,
  documentIds: string[],
  identityId: string,
  options: DocumentDelegationOptions = {}
): Promise<DelegationVerdict> {
  const wanted = bareId(identityId);
  const minimum = runtime.Access.fromString(options.minimumAccess ?? "admin");

  let anyHeld = false;
  let anyDirectMember = false;

  for (const documentId of documentIds) {
    const document = await hive.keyhive.getDocument(
      new runtime.DocumentId(hexToBytes(bareId(documentId)))
    );
    if (!document) continue;
    anyHeld = true;

    for (const capability of await document.members()) {
      const memberId = bytesToHex(capability.who.id.toBytes());
      if (memberId !== wanted) continue;
      anyDirectMember = true;
      if (capability.can.atLeast(minimum)) return "delegates";
    }
  }

  // Only a direct delegation below the minimum is insufficient. An unheld
  // document proves nothing, and neither does absence from the direct
  // members: access may route through a group this check does not walk.
  return anyHeld && anyDirectMember ? "insufficient" : "unknown";
}

/** Hex ids without an `0x` prefix, lowercased, for comparison. */
export function bareId(id: string): string {
  return (id.startsWith("0x") ? id.slice(2) : id).toLowerCase();
}
