// Shared ONO0 conformance vectors, authored by keyhive-todo-app-demo from
// their 34 record tests plus the 2026-09-02 canonical rulings, and destined
// for onomancy's Rust conformance table. Vendored (not read from the bridge)
// so the suite is hermetic; provenance sha of the bridged original (rev 2):
// f35db62be31faaa0ace91724722dbf1c444fad0a02b9b8b8ad96ec3c8fe6d0a2
//
// Rev 2 fixed the u64-adjacent vector (now carries nowMs) and added three
// deferral vectors, including the exact-boundary pin (<= bound selects).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { URL } from "node:url";

const { createOnomancyRuntime, parseRecord } =
  await import("../dist/onomancy/index.js");

const vectors = fs
  .readFileSync(new URL("./ono0-conformance-vectors.jsonl", import.meta.url))
  .toString()
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

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
      const b = await classify(v.input, v.nowMs ? BigInt(v.nowMs) : undefined);
      const status = b.contested
        ? "contested"
        : b.ids.length
          ? "bound"
          : "unbound";
      assert.equal(status, v.expected.status);
      if (v.expected.serial !== undefined) {
        assert.equal(String(b.serial), String(v.expected.serial));
      }
      if (v.expected.status === "bound") assert.equal(b.ids.length, 1);
      if (typeof v.expected.documents === "number") {
        assert.equal(b.ids.length, v.expected.documents);
      }
      if (typeof v.expected.deferred === "number") {
        assert.equal(b.deferredSerials ?? 0, v.expected.deferred);
      }
    });
  }
  // kind === "nextSerial": publisher-side; this library has no publisher.
}
