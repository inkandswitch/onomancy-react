import { useEffect, useMemo, useRef } from "react";
import type { NameDirectory } from "../directory/types.js";
import type { OnomancyRuntime } from "./runtime.js";
import {
  clearVerificationVerdicts,
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
 *
 * ## Keeping verdicts current
 *
 * Pass `revalidate` — the counter from `useKeyhiveUpdates` is the intended
 * source — and the designation verdicts are dropped whenever it changes,
 * while DNS resolutions are kept.
 *
 * Without it, an entry whose designated document had not arrived at first
 * read stays `unsynced` for the life of the cache, telling the user a
 * document they are holding has not synced. The verdict is a claim about
 * local keyhive state and goes stale for a local reason; nothing about DNS
 * changed, so re-resolving would be wasted DoH traffic.
 *
 * `revalidate` is a **re-read trigger**, which is what `useKeyhiveUpdates`
 * is safe as. It bumps on every `ingest-remote`, so it is a heartbeat rather
 * than a version — do not key a timeout off it.
 */
export interface UseOnomancyDirectoryOptions extends OnomancyDirectoryOptions {
  /**
   * Drop the designation verdicts whenever this changes, keeping DNS
   * resolutions. Pass the counter from `useKeyhiveUpdates`.
   *
   * Hook-only: {@link createOnomancyDirectory} has no use for it, because
   * outside React the caller decides when to re-check by calling
   * `clearVerificationVerdicts` directly.
   */
  revalidate?: unknown;
}

export function useOnomancyDirectory(
  base: NameDirectory,
  runtime: OnomancyRuntime,
  options: UseOnomancyDirectoryOptions = {}
): NameDirectory {
  const { designation, notice, cache: provided, revalidate } = options;

  const held = useRef<VerificationCache | null>(null);
  if (held.current === null) held.current = createVerificationCache();
  const cache = provided ?? held.current;

  // Skip the first run: nothing has been verified yet, so there is nothing
  // stale to drop, and clearing an empty cache would notify every subscriber
  // for no reason.
  const seen = useRef(false);
  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      return;
    }
    clearVerificationVerdicts(cache);
  }, [cache, revalidate]);

  return useMemo(
    () =>
      createOnomancyDirectory(base, runtime, { designation, notice, cache }),
    [base, runtime, designation, notice, cache]
  );
}
