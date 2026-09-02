import type {
  Access,
  ContactCard,
  DocumentId,
  Identifier,
} from "@automerge/automerge-repo-keyhive";
import type { AutomergeUrl } from "@automerge/react/slim";

/**
 * The keyhive constructors this package needs supplied by the application so
 * that there is only ever one instance of the WASM-backed packages.
 */
export interface KeyhiveRuntime {
  readonly Access: {
    relay(): Access;
    read(): Access;
    edit(): Access;
    admin(): Access;
    /** Case-insensitive. Throws on an unrecognized level. */
    fromString(level: string): Access;
  };
  readonly ContactCard: {
    fromJson(json: string): ContactCard | undefined;
  };
  readonly DocumentId: {
    new (bytes: Uint8Array): DocumentId;
  };
  readonly Identifier: {
    new (bytes: Uint8Array): Identifier;
    publicId(): Identifier;
  };
  docIdFromAutomergeUrl(url: AutomergeUrl): DocumentId;
  isUnprotectedDoc(url: AutomergeUrl): boolean;
}

/** The subset of ARK's exports the runtime reads. */
export type KeyhiveModule = KeyhiveRuntime;

/**
 * Build a runtime from the application's own ARK import.
 *
 * Every *function* member is an arrow closing over `ark`, never a method
 * reading `this`. That is deliberate and load-bearing: consumers pass these
 * detached, and a member that grew a `this` would break every such call
 * site at runtime with nothing at the type level to warn them. Arrow
 * functions have no own `this`, so the mistake cannot be made here rather
 * than merely not having been made yet. The same rule holds for
 * `createOnomancyRuntime`.
 *
 * `Access`, `ContactCard`, `DocumentId` and `Identifier` are class
 * references rather than functions, so the concern does not apply to them
 * and they need no conversion.
 */
export function createKeyhiveRuntime(ark: KeyhiveModule): KeyhiveRuntime {
  return {
    Access: ark.Access,
    ContactCard: ark.ContactCard,
    DocumentId: ark.DocumentId,
    Identifier: ark.Identifier,
    docIdFromAutomergeUrl: (url) => ark.docIdFromAutomergeUrl(url),
    isUnprotectedDoc: (url) => ark.isUnprotectedDoc(url),
  };
}
