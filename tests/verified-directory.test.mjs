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

test("x = 0 with the sign bit set is not a point", async () => {
  // RFC 8032 §5.1.3 final rule: x = 0 cannot carry a sign bit. y = 1 gives
  // x = 0 (the neutral element) and is valid; the same y with the sign bit
  // set is the one encoding class the fill(k) table cannot reach.
  const { parseRecord } = await import("../dist/onomancy/index.js");
  const y1 = new Uint8Array(32);
  y1[0] = 1;
  const signed = Uint8Array.from(y1);
  signed[31] |= 0x80;
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  const rec = (p) =>
    `v=ONO0;k=ed25519;n=5;g=${b64(new Uint8Array(32).fill(1))};p=${p}`;
  assert.ok(parseRecord(rec(b64(y1))), "y=1, x=0 unsigned is a valid point");
  assert.equal(
    parseRecord(rec(b64(signed))),
    undefined,
    "x=0 + sign bit is not"
  );
});

test("non-canonical base64 spellings are malformed, not aliases", async () => {
  // The grammar is strict: one record has one spelling. atob is forgiving,
  // so without the canonical round-trip, unpadded and trailing-bit variants
  // of one key parse as the same record - the parser-differential class -
  // and two spellings of one generation key manufacture a phantom contest.
  const { parseRecord } = await import("../dist/onomancy/index.js");
  const key = Buffer.from(new Uint8Array(32).fill(1)).toString("base64"); // canonical, ends "="
  const unpadded = key.slice(0, -1);
  // Flip a low bit in the final character: same decoded bytes under atob.
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = key[42];
  const trailing = key.slice(0, 42) + chars[chars.indexOf(last) + 1] + "=";
  const rec = (g) => `v=ONO0;k=ed25519;n=5;g=${g};p=${key}`;
  assert.ok(parseRecord(rec(key)), "canonical spelling parses");
  assert.equal(parseRecord(rec(unpadded)), undefined, "unpadded is malformed");
  assert.equal(
    parseRecord(rec(trailing)),
    undefined,
    "trailing-bit variant is malformed"
  );
});

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
    {
      resolveHostname: async () => script.shift(),
      Name: class {
        constructor(raw) {
          const bare = raw.startsWith("@") ? raw.slice(1) : raw;
          this.anchor = "@" + bare.toLowerCase();
          this.anchorKind = "dns";
          this.segments = [];
        }
        free() {}
      },
    },
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
