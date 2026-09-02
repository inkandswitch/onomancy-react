import { useMemo, useRef } from "react";
import type { NameDirectory } from "../directory/types.js";
import type { OnomancyRuntime } from "./runtime.js";
import {
  createOnomancyDirectory,
  createVerificationCache,
  type OnomancyDirectoryOptions,
  type VerificationCache,
} from "./verified-directory.js";

/**
 * `createOnomancyDirectory` with its verification results kept safe across
 * rebuilds.
 *
 * The wrapper is still memoized on `base`, so a directory backed by a live
 * Automerge document is rebuilt on every write — the document is a new
 * object each time. What no longer happens is the rebuild throwing away
 * every verdict with it: the cache lives in a ref, outlives the wrapper, and
 * so a rebuild costs a wrapper allocation rather than a fresh DoH round trip
 * per claimed hostname.
 *
 * Pass `options.cache` to share results more widely, or to hold the handle
 * you need for `clearVerificationCache`.
 */
export function useOnomancyDirectory(
  base: NameDirectory,
  runtime: OnomancyRuntime,
  options: OnomancyDirectoryOptions = {}
): NameDirectory {
  const { designation, notice, cache: provided } = options;

  const held = useRef<VerificationCache | null>(null);
  if (held.current === null) held.current = createVerificationCache();
  const cache = provided ?? held.current;

  return useMemo(
    () =>
      createOnomancyDirectory(base, runtime, { designation, notice, cache }),
    [base, runtime, designation, notice, cache]
  );
}
