// Behaviour pins for the surfaces promoted out of the applications once
// the flat-namestore migration landed: the namestore write helpers, the
// reverse-binding designation combinator, and the directory composition.
// Promoted precisely so the rules cannot drift between consumers, which
// makes these pins the single place the rules are stated executable.
import { test } from "node:test";
import assert from "node:assert/strict";

const { bindEdge, unbindEdge, composeDirectories } =
  await import("../dist/index.js");
const { requireReverseBinding } = await import("../dist/onomancy/index.js");

// A stand-in for the substrate's scalar-string wrapper: the helpers only
// ever assign what `toReference` returns, so any marker shape proves the
// injection is honored.
const toReference = (url) => ({ val: url });

test("bindEdge writes the flat key through the injected reference", () => {
  const doc = {};
  bindEdge(doc, "todos/groceries", "automerge:2AbC", toReference);
  assert.deepEqual(doc["todos/groceries"], { val: "automerge:2AbC" });
});

test("a rebind migrates its own path out of the legacy container", () => {
  const doc = { onomancy: { "todos/groceries": "automerge:2Old" } };
  bindEdge(doc, "todos/groceries", "automerge:2New", toReference);
  assert.deepEqual(doc["todos/groceries"], { val: "automerge:2New" });
  assert.equal(
    "todos/groceries" in doc.onomancy,
    false,
    "the retired copy must not linger to resurrect on a later unbind"
  );
});

test("unbindEdge deletes from both layouts", () => {
  const doc = {
    "todos/groceries": { val: "automerge:2New" },
    onomancy: { "todos/groceries": "automerge:2Old" },
  };
  unbindEdge(doc, "todos/groceries");
  assert.equal("todos/groceries" in doc, false);
  assert.equal("todos/groceries" in doc.onomancy, false);
});

test("both write helpers refuse reserved paths before touching the document", () => {
  const doc = {};
  for (const path of [
    ".well-known",
    ".well-known/onomancy/certificates",
    ".well-known/other-app/data",
  ]) {
    assert.throws(
      () => bindEdge(doc, path, "automerge:2AbC", toReference),
      /reserved/,
      `bind at ${path}`
    );
    assert.throws(() => unbindEdge(doc, path), /reserved/, `unbind at ${path}`);
  }
  assert.deepEqual(doc, {}, "nothing was written on any refusal");

  // A prefix rule, not a substring rule.
  bindEdge(doc, ".well-knownish", "automerge:2AbC", toReference);
  assert.ok(doc[".well-knownish"]);
});

test("requireReverseBinding takes the weaker verdict", async () => {
  const entry = { id: "aa".repeat(32), name: "Alice" };
  const inner = (verdict) => async () => verdict;
  const check = (answers) => async (id) => answers[id] ?? "absent";

  const designation = (innerVerdict, answers) =>
    requireReverseBinding(check(answers), inner(innerVerdict))(
      entry,
      Object.keys(answers),
      "a.example"
    );

  // The decision table, row by row.
  assert.equal(
    await designation("designates", { doc1: "accepted" }),
    "designates"
  );
  assert.equal(
    await designation("designates", { doc1: "absent" }),
    "unknown",
    "no certificate is silence, not denial"
  );
  assert.equal(
    await designation("designates", { doc1: "rejected" }),
    "excludes",
    "evidence that arrived and failed convicts"
  );
  // One accepting document among several is enough (mid-migration
  // dual-publish), and acceptance beats a sibling's rejection.
  assert.equal(
    await designation("designates", { doc1: "rejected", doc2: "accepted" }),
    "designates"
  );
  // Anything but designates passes through untouched: the reverse half is
  // only asked about documents the forward half already granted.
  assert.equal(await designation("excludes", { doc1: "accepted" }), "excludes");
  assert.equal(await designation("unknown", { doc1: "accepted" }), "unknown");
});

test("composed publish attempts both writes even when one rejects", async () => {
  const base = {
    source: "x",
    trust: "unverified",
    writable: true,
    enumerable: true,
    notice: "",
    lookup: () => undefined,
    list: () => [],
  };
  let fallbackSaw;
  const primary = {
    ...base,
    publish: async () => {
      throw new Error("shared write rejected");
    },
  };
  const fallback = {
    ...base,
    publish: async (entry) => {
      fallbackSaw = entry;
    },
  };

  const composed = composeDirectories(primary, fallback);
  await assert.rejects(
    () => composed.publish({ id: "aa".repeat(32), name: "Alice" }),
    /shared write rejected/
  );
  assert.equal(
    fallbackSaw?.name,
    "Alice",
    "the local write must not be lost to the shared write's rejection"
  );
});
