// Shared ONO0 conformance vectors, authored by keyhive-todo-app-demo from
// their 34 record tests plus the 2026-09-02 canonical rulings, and destined
// for onomancy's Rust conformance table. Vendored (not read from the bridge)
// so the suite is hermetic; provenance sha of the bridged original (rev 3):
// f7ebdb439780e2b1d3d0372d2cb077ed4be2204ccc011e590f3f6caccd0ab3cf
//
// Rev history: rev 1 caught this parser's lax g= and missing 255-char limit;
// rev 2 (canonical referee) caught the demo's missing skew deferral; rev 3
// (reference harness) caught missing point-validity in BOTH parsers and
// non-point fixture keys in the vectors themselves. Each round's bug was
// invisible to the previous round's process.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

const { createOnomancyRuntime, parseRecord } =
  await import("../dist/onomancy/index.js");

const vectors = fs
  .readFileSync(new URL("./ono0-conformance-vectors.jsonl", import.meta.url))
  .toString()
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

// Guard against silent degradation: a truncated or partially-unparsed vector
// file must fail loudly, not pass vacuously. Counts pinned to rev 3.
test("vector file carries the full rev 3 corpus", () => {
  const byKind = {};
  for (const v of vectors)
    byKind[v.kind ?? "meta"] = (byKind[v.kind ?? "meta"] ?? 0) + 1;
  assert.deepEqual(byKind, { meta: 1, parse: 21, classify: 14, nextSerial: 7 });
  assert.equal(vectors.find((v) => v.kind === "meta")?.revision, 3);
});

// The meta's document aliases, resolved to the hex ids our API reports.
const DOC_ALIAS = {
  doc1: Buffer.from(new Uint8Array(32).fill(1)).toString("hex"),
  doc2: Buffer.from(new Uint8Array(32).fill(3)).toString("hex"),
};

const classify = async (records, nowMs) =>
  createOnomancyRuntime(
    {
      resolveHostname: async () => ({ records }),
      Name: class {
        constructor() {}
      },
    },
    { now: () => Number(nowMs ?? 1788000000000n) }
  ).resolveBoundIds("x.example");

for (const v of vectors) {
  if (v.kind === "parse") {
    test(`parse: ${v.name}`, () => {
      const r = parseRecord(v.input);
      // Resolver granularity: every non-parsed disposition is one skip.
      assert.equal(!!r, v.expected === "parsed");
      if (r && v.serial !== undefined) {
        assert.equal(String(r.serial), String(v.serial));
      }
    });
  } else if (v.kind === "classify") {
    test(`classify: ${v.name}`, async () => {
      const b = await classify(
        v.input,
        v.nowMs !== undefined ? BigInt(v.nowMs) : undefined
      );
      const status = b.contested
        ? "contested"
        : b.ids.length
          ? "bound"
          : "unbound";
      assert.equal(status, v.expected.status);
      if (v.expected.serial !== undefined) {
        assert.equal(String(b.serial), String(v.expected.serial));
      }
      if (v.expected.status === "bound") {
        assert.equal(b.ids.length, 1);
        // The document identity, not just the count: a wire-order-dependent
        // selection with the right serial passed this suite before this
        // assertion existed.
        if (v.expected.document) {
          const want = DOC_ALIAS[v.expected.document];
          assert.ok(want, `unknown document alias ${v.expected.document}`);
          assert.equal(b.ids[0], want);
        }
      }
      if (typeof v.expected.documents === "number") {
        assert.equal(b.ids.length, v.expected.documents);
      }
      // Meta: deferred is 0 when omitted — assert always, not only when set,
      // so a fabricated deferredSerials on a bound answer cannot survive.
      assert.equal(b.deferredSerials ?? 0, v.expected.deferred ?? 0);
    });
  }
  // kind === "nextSerial": publisher-side; this library has no publisher.
}
