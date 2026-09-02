import { useMemo } from "react";
import type { NameDirectory } from "../directory/types.js";
import type { OnomancyRuntime } from "./runtime.js";
import {
  createOnomancyDirectory,
  type OnomancyDirectoryOptions,
} from "./verified-directory.js";

/**
 * `createOnomancyDirectory` memoized on the base directory, so verification
 * results are re-checked when the base directory's identity changes.
 */
export function useOnomancyDirectory(
  base: NameDirectory,
  runtime: OnomancyRuntime,
  options: OnomancyDirectoryOptions = {}
): NameDirectory {
  const { designation, notice } = options;
  return useMemo(
    () => createOnomancyDirectory(base, runtime, { designation, notice }),
    [base, runtime, designation, notice]
  );
}
