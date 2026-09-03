// Behaviour pins for the onomancy directory wrapper, run against the built
// library (`pnpm build` first; CI builds before testing). Bare `node --test`
// works because the dist modules these paths load keep their dependencies
// injectable; note dist DOES import react (check-isolation.mjs allows
// exactly that), so a copied-out dist without node_modules will not load.
//
// Each pin exists because every other gate passes with its behaviour
// reverted — these were verified to fail against pre-fix builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { setTimeout } from "node:timers";
import console from "node:console";
import { URL } from "node:url";

const {
  createOnomancyDirectory,
  createOnomancyRuntime,
  createVerificationCache,
} = await import("../dist/onomancy/index.js");

// The real module, with only resolution faked: the grammar, the RRset
// rules, and the anchor decoder are never stubbed, so these pins exercise
// the same judgement path an application gets.
const onomancy = await import("@inkandswitch/onomancy");
const moduleWith = (resolveHostname) => ({ ...onomancy, resolveHostname });

const noopRuntime = () =>
  createOnomancyRuntime(moduleWith(async () => ({ records: [] })));

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
    // An identity-deduplicating base: a directory that dedupes listeners
    // by identity would collapse two subscriptions sharing one callback.
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
  // Selection keyed on the document alone reads this as agreeing duplicates
  // and picks a generation arbitrarily; the reference verifier refuses it.
  // The rule now lives in the module's classifyRecords — the pin here is
  // that the runtime's mapping carries the contest through: the flag set,
  // the one document still reported.
  const A = "aa".repeat(32);
  const b64 = (h) => Buffer.from(h, "hex").toString("base64");
  const rec = (g) => `v=ONO0;k=ed25519;n=5;g=${g};p=${b64(A)}`;
  const runtime = createOnomancyRuntime(
    moduleWith(async () => ({
      records: [rec(b64("11".repeat(32))), rec(b64("22".repeat(32)))],
    })),
    { now: () => 1788000000000 }
  );

  const binding = await runtime.resolveBoundIds("a.example");
  assert.equal(binding.contested, true, "rotation tie must be contested");
  assert.equal(binding.ids.length, 1, "one document, still reported");
  assert.equal(binding.ids[0], A, "and it is the document, in hex");
});

// The parser-rule pins that used to live here — fill-fixture point
// validity, the x=0 sign-bit edge, non-canonical base64 spellings — moved
// with the parser itself: the rules are onomancy's (`TxtRecord`, tested in
// Rust and replayed from the shared vectors in conformance-vectors.test.mjs),
// and this library holds no copy left to pin.

// Local runs can test a stale dist; CI rebuilds first. Warn, do not fail.
{
  const newest = (dir) => {
    let max = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      max = Math.max(max, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
    }
    return max;
  };
  const src = new URL("../src", import.meta.url).pathname;
  const dist = new URL("../dist/index.js", import.meta.url).pathname;
  if (newest(src) > fs.statSync(dist).mtimeMs) {
    console.warn(
      "WARN: dist/ is older than src/ - run pnpm build before trusting these results"
    );
  }
}

test("a contested serial does not enter the ratchet", async () => {
  // The ratchet remembers the highest serial ACCEPTED. Pin: contested@10
  // (refused), then the zone heals to a single record at the SAME serial on
  // a stale chain - must verify, not read as replayed.
  const {
    createOnomancyDirectory,
    createOnomancyRuntime,
    createVerificationCache,
    clearVerificationCache,
  } = await import("../dist/onomancy/index.js");
  const lib = await import("../dist/index.js");
  const A = "aa".repeat(32);
  const b64h = (h) => Buffer.from(h, "hex").toString("base64");
  const G1 = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");
  const G2 = Buffer.from(new Uint8Array(32).fill(6)).toString("base64");
  const rec = (g) => `v=ONO0;k=ed25519;n=10;g=${g};p=${b64h(A)}`;
  let script = [
    { records: [rec(G1), rec(G2)], freshness: "stale" }, // contested @10
    { records: [rec(G1)], freshness: "stale" }, // healed @10, stale chain
  ];
  const rt = createOnomancyRuntime(
    moduleWith(async () => script.shift()),
    { now: () => 1788000000000 }
  );
  const cache = createVerificationCache();
  const base = lib.createAutomergeDocDirectory(
    { [A]: { name: "A", dnsName: "a.example" } },
    undefined
  );
  const d = createOnomancyDirectory(base, rt, {
    designation: (await import("../dist/onomancy/index.js"))
      .idEqualityDesignation,
    cache,
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      d.lookup(A);
      await new Promise((r) => setTimeout(r, 25));
    }
    return d.lookup(A).dnsNameStatus;
  };
  assert.equal(await settle(), "contested");
  clearVerificationCache(cache);
  assert.equal(
    await settle(),
    "verified",
    "healed same-serial zone must not read replayed"
  );
});
