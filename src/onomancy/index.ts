/**
 * DNS name verification through onomancy.
 *
 * Imported as `@inkandswitch/onomancy-react/onomancy`, separately from the main
 * entry point. The split follows the domains rather than the layers: the
 * main entry knows what a DNS name claim is and what the twelve statuses mean,
 * and renders them; everything that *resolves* a name lives here.
 *
 * That makes this subpath optional in practice. An application that
 * computes `dnsNameStatus` itself — because it already holds onomancy, or
 * because it verifies against something other than DNS — can use the
 * components and the `DirectoryEntry` fields without importing any of this.
 * The rules such an application must follow are on `DnsNameStatus`, which
 * is on the main entry precisely so it binds either way.
 *
 * The isolation guarantee is unchanged and unweakened: like the main entry,
 * nothing here imports anything but React. The onomancy Wasm arrives by
 * injection through {@link createOnomancyRuntime}, so the host application
 * still owns the only instance.
 */

export { createOnomancyRuntime } from "./runtime.js";
export type {
  HostnameBinding,
  OnomancyClassification,
  OnomancyModule,
  OnomancyName,
  OnomancyRecordCandidate,
  OnomancyRuntime,
  OnomancyRuntimeOptions,
} from "./runtime.js";

export {
  createKeyhiveDesignation,
  idEqualityDesignation,
} from "./designation.js";
export type {
  DesignationVerdict,
  DnsDesignation,
  KeyhiveDesignationOptions,
} from "./designation.js";

export { requireReverseBinding } from "./reverse-binding.js";
export type {
  ReverseBindingCheck,
  ReverseBindingClaim,
} from "./reverse-binding.js";

export {
  clearVerificationCache,
  clearVerificationVerdicts,
  createOnomancyDirectory,
  createVerificationCache,
} from "./verified-directory.js";
export type {
  OnomancyDirectoryOptions,
  VerificationCache,
} from "./verified-directory.js";

export { useOnomancyDirectory } from "./useOnomancyDirectory.js";
export type { UseOnomancyDirectoryOptions } from "./useOnomancyDirectory.js";
