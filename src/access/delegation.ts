import type { AutomergeRepoKeyhiveBase } from "@automerge/automerge-repo-keyhive";
import { bytesToHex, hexToBytes } from "../bytes.js";
import type { KeyhiveRuntime } from "../runtime.js";

/**
 * Whether documents delegate to an identity at a required level.
 *
 * The three values are deliberately not two. `insufficient` means a held
 * document was walked — transitively, groups included — and does not grant
 * the identity the minimum by any path: positive evidence of non-membership
 * or under-delegation. `unknown` means the question could not be answered
 * at all, because no named document is held on this device.
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
 * The walk is transitive: `docMemberCapabilities` expands nested groups and
 * reports each reachable identity with the access its chain grants (the
 * minimum along the chain, not the level of the last edge). Because the walk
 * is complete, a held document that reaches nobody is positive evidence of
 * non-membership (`insufficient`); `unknown` means only that the document is
 * not here to ask.
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

  for (const documentId of documentIds) {
    const docId = new runtime.DocumentId(hexToBytes(bareId(documentId)));
    const document = await hive.keyhive.getDocument(docId);
    if (!document) continue;
    anyHeld = true;

    for (const capability of await hive.docMemberCapabilities(docId)) {
      const memberId = bytesToHex(capability.who.id.toBytes());
      if (memberId !== wanted) continue;
      if (capability.can.atLeast(minimum)) return "delegates";
    }
  }

  // A held document that does not reach this identity by any path is
  // evidence of non-membership, not an absence of evidence — which is only
  // true because the walk above is transitive. An unheld document still
  // proves nothing: it is not here to ask.
  return anyHeld ? "insufficient" : "unknown";
}

/** Hex ids without an `0x` prefix, lowercased, for comparison. */
export function bareId(id: string): string {
  return (id.startsWith("0x") ? id.slice(2) : id).toLowerCase();
}
