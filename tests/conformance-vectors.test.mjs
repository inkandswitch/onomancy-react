// Shared ONO0 conformance vectors, authored by keyhive-todo-app-demo from
// their record tests plus the 2026-09-02/03 canonical rulings; their home
// is onomancy's conformance table. Vendored (not read from the bridge) so
// the suite is hermetic.
//
// Rev history: rev 1 caught this parser's lax g= and missing 255-char limit;
// rev 2 (canonical referee) caught the demo's missing skew deferral; rev 3
// (reference harness) caught missing point-validity in BOTH parsers and
// non-point fixture keys in the vectors themselves; rev 4 pinned strict
// base64 canonicality and the two decompression edges no fill fixture can
// reach — which the verification run then caught the Rust decoder accepting.
// Each round's bug was invisible to the previous round's process.
//
// This library no longer carries the rules the vectors judge: parsing and
// selection moved into `@inkandswitch/onomancy` (`classifyRecords`), and
// what remains here is `createOnomancyRuntime`'s mapping onto
// `HostnameBinding`. The replay therefore runs at two levels — parse
// vectors against the module the app injects, classify vectors through the
// runtime — so a regression in either the rules or the mapping goes red.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

const onomancy = await import("@inkandswitch/onomancy");
const { createOnomancyRuntime } = await import("../dist/onomancy/index.js");

const vectors = fs
  .readFileSync(new URL("./ono0-conformance-vectors.jsonl", import.meta.url))
  .toString()
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

// Guard against silent degradation: a truncated or partially-unparsed vector
// file must fail loudly, not pass vacuously. Counts pinned to rev 4.
test("vector file carries the full rev 4 corpus", () => {
  const byKind = {};
  for (const v of vectors)
    byKind[v.kind ?? "meta"] = (byKind[v.kind ?? "meta"] ?? 0) + 1;
  assert.deepEqual(byKind, { meta: 1, parse: 25, classify: 15, nextSerial: 7 });
  assert.equal(vectors.find((v) => v.kind === "meta")?.revision, 4);
});

// The meta's document aliases, resolved to the hex ids our API reports.
const DOC_ALIAS = {
  doc1: Buffer.from(new Uint8Array(32).fill(1)).toString("hex"),
  doc2: Buffer.from(new Uint8Array(32).fill(3)).toString("hex"),
};

const SKEW_MS = 300000n;

// A fixed, realistic instant where the vectors leave the clock open.
const FIXED_NOW_MS = 1788000000000n;

// The module refuses implausible clocks (its seconds-vs-milliseconds
// validation), so a vector needing one is exercised against the internal
// Rust rule only — sanctioned by the vectors' meta.
const IMPLAUSIBLE_SECONDS = 100000000000n;

/** A clock (ms) at which `serial` escapes deferral, or undefined. */
const clockForMs = (serial) => {
  const value = BigInt(serial);
  const floor = value > SKEW_MS ? value - SKEW_MS : 0n;
  if (floor / 1000n >= IMPLAUSIBLE_SECONDS) return undefined;
  return floor > FIXED_NOW_MS ? floor : FIXED_NOW_MS;
};

const classify = async (records, nowMs) =>
  createOnomancyRuntime(
    { ...onomancy, resolveHostname: async () => ({ records }) },
    { now: () => Number(nowMs ?? FIXED_NOW_MS) }
  ).resolveBoundIds("x.example");

for (const v of vectors) {
  if (v.kind === "parse") {
    // Module level: the rules themselves, disposition by disposition.
    test(`parse: ${v.name}`, () => {
      if (v.expected === "parsed") {
        const nowMs =
          v.serial === undefined ? FIXED_NOW_MS : clockForMs(v.serial);
        if (nowMs === undefined) {
          // No plausible clock admits the serial (the u64 ceiling), but
          // only a grammatical binding can land in `deferred`.
          const out = onomancy.classifyRecords(
            [v.input],
            Number(FIXED_NOW_MS / 1000n)
          );
          assert.equal(out.malformed + out.foreign + out.unknownVersion, 0);
          assert.equal(out.deferred, 1);
          return;
        }
        const out = onomancy.classifyRecords([v.input], Number(nowMs / 1000n));
        assert.equal(out.malformed + out.foreign + out.unknownVersion, 0);
        assert.equal(out.selected?.serial, v.serial);
      } else {
        const out = onomancy.classifyRecords(
          [v.input],
          Number(FIXED_NOW_MS / 1000n)
        );
        assert.equal(out[v.expected], 1, `expected one ${v.expected}`);
        assert.equal(out.selected, undefined);
        assert.equal(out.contested, undefined);
      }
    });
  } else if (v.kind === "classify") {
    // Runtime level: the same rules THROUGH resolveBoundIds, plus the
    // mapping to hex ids, the contested flag, and the deferral count.
    if (
      v.nowMs !== undefined &&
      BigInt(v.nowMs) / 1000n >= IMPLAUSIBLE_SECONDS
    ) {
      // The module refuses a clock this far out as implausible, so the
      // vector is exercised against the internal Rust rule only (vectors'
      // meta, `nowSecondsCaveat`).
      test(`classify: ${v.name}`, { skip: "clock beyond the plausible bound" });
      continue;
    }
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
  } else if (v.kind === "nextSerial") {
    // Module level: this library has no publisher, but the rule is one
    // import away and the vectors are already in hand.
    test(`nextSerial: ${v.name}`, () => {
      const last = v.last === null ? undefined : v.last;
      const now = Number(v.now);
      if (v.expected === "refuse") {
        assert.throws(() => onomancy.nextSerial(last, now));
      } else {
        assert.equal(onomancy.nextSerial(last, now), v.expected);
      }
    });
  }
}
