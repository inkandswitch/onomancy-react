// Behaviour pins for the onomancy directory wrapper, run against the built
// library (`pnpm build` first; CI builds before testing). Bare `node --test`:
// dist/ imports only React-free modules on these paths, which
// check-isolation.mjs guarantees.
//
// Each pin exists because every other gate passes with its behaviour
// reverted — these were verified to fail against pre-fix builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

const {
  createOnomancyDirectory,
  createOnomancyRuntime,
  createVerificationCache,
} = await import("../dist/onomancy/index.js");

const noopRuntime = () =>
  createOnomancyRuntime({
    resolveHostname: async () => ({ records: [] }),
    Name: class {
      constructor() {}
    },
  });

test("publish strips every verification decoration, nothing else", async () => {
  let published;
  const base = {
    source: "test",
    trust: "unverified",
    writable: true,
    enumerable: true,
    notice: "",
    lookup: () => undefined,
    list: () => [],
    publish: (entry) => {
      published = entry;
    },
  };
  const directory = createOnomancyDirectory(base, noopRuntime(), {
    cache: createVerificationCache(),
  });

  directory.publish({
    id: "aa".repeat(32),
    name: "Alice",
    dnsName: "",
    dnsNameStatus: "verified",
    dnsNameFreshness: "stale",
    dnsNameLapsedSeconds: 3600,
  });

  // Whole-entry equality: decorations gone, everything else — including the
  // empty-string dnsName that clears a claim — delivered intact.
  assert.deepEqual(published, {
    id: "aa".repeat(32),
    name: "Alice",
    dnsName: "",
  });
});

test("two subscriptions sharing one callback survive one unsubscribe", async () => {
  const baseListeners = new Set();
  const base = {
    source: "test",
    trust: "unverified",
    writable: false,
    enumerable: true,
    notice: "",
    lookup: () => undefined,
    list: () => [],
    // An identity-deduplicating base, like the demo's localDirectory.
    subscribe: (fn) => {
      baseListeners.add(fn);
      return () => baseListeners.delete(fn);
    },
  };
  const directory = createOnomancyDirectory(base, noopRuntime(), {
    cache: createVerificationCache(),
  });

  let hits = 0;
  const shared = () => hits++;
  const offA = directory.subscribe(shared);
  directory.subscribe(shared);

  assert.equal(
    baseListeners.size,
    2,
    "each subscribe registers its own closure"
  );

  offA();
  assert.equal(baseListeners.size, 1, "one unsubscribe removes exactly one");

  for (const fn of baseListeners) fn();
  assert.equal(hits, 1, "the surviving subscription still fires");
});

test("contests a rotation tie: same document, different generation keys", async () => {
  // Candidate vector for classifyRecords: the old selection keyed ties on
  // document alone, so this case read as agreeing duplicates and picked a
  // generation arbitrarily. The reference verifier refuses it.
  const { createOnomancyRuntime } = await import("../dist/onomancy/index.js");
  const A = "aa".repeat(32);
  const b64 = (h) => Buffer.from(h, "hex").toString("base64");
  const rec = (g) => `v=ONO0;k=ed25519;n=5;g=${g};p=${b64(A)}`;
  const runtime = createOnomancyRuntime(
    {
      resolveHostname: async () => ({
        records: [rec(b64("11".repeat(32))), rec(b64("22".repeat(32)))],
      }),
      Name: class {
        constructor() {}
      },
    },
    { now: () => 1788000000000 }
  );

  const binding = await runtime.resolveBoundIds("a.example");
  assert.equal(binding.contested, true, "rotation tie must be contested");
  assert.equal(binding.ids.length, 1, "one document, still reported");
});

test("g= and p= must decompress to ed25519 curve points", async () => {
  // The ratified grammar: "decoders MUST reject a unit whose key field does
  // not decompress" (specs/serialization.md). Reference validity table for
  // fill(32, k) fixtures, from onomancy's harness.
  const { parseRecord } = await import("../dist/onomancy/index.js");
  const b64 = (k) => Buffer.from(new Uint8Array(32).fill(k)).toString("base64");
  const valid = [0, 1, 3, 6, 9, 10, 11, 12, 16];
  const invalid = [2, 4, 5, 7, 8, 13, 14, 15];
  for (const k of valid) {
    assert.ok(
      parseRecord(`v=ONO0;k=ed25519;n=5;g=${b64(1)};p=${b64(k)}`),
      `fill(${k}) is a point and must parse`
    );
  }
  for (const k of invalid) {
    assert.equal(
      parseRecord(`v=ONO0;k=ed25519;n=5;g=${b64(1)};p=${b64(k)}`),
      undefined,
      `fill(${k}) is not a point and must be malformed`
    );
    assert.equal(
      parseRecord(`v=ONO0;k=ed25519;n=5;g=${b64(k)};p=${b64(1)}`),
      undefined,
      `non-point g= fill(${k}) must be malformed too`
    );
  }
});
