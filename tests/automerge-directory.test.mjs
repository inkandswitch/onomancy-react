// Behaviour pins for the shared-document directory under the flat
// namestore layout, where directory entries, namestore edges (scalar
// strings), and protocol data (`.well-known/…`) share one top-level map.
//
// Each pin verified to go red against a build without its guard: an
// unguarded publish at a protocol key succeeds and then becomes
// unreadable, replacing data another owner defines — the certificate
// list among it, whose replacement silently degrades every verified
// `@host` badge for the document.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createAutomergeDocDirectory } = await import("../dist/index.js");

test("publish refuses protocol keys, loudly", () => {
  const doc = {};
  const directory = createAutomergeDocDirectory(doc, (fn) => fn(doc));

  for (const id of [
    "onomancy", // the legacy container, guarded through its migration window
    ".well-known",
    ".well-known/onomancy/certificates",
    ".well-known/other-app/data",
  ]) {
    assert.throws(
      () => directory.publish({ id, name: "Mallory" }),
      /reserved/,
      `${id} must refuse`
    );
  }

  // A prefix rule, not a substring rule.
  directory.publish({ id: ".well-knownish", name: "odd but allowed" });
  assert.equal(directory.lookup(".well-knownish")?.name, "odd but allowed");
});

test("reads skip protocol keys and non-entry shapes, by key and by shape", () => {
  const alice = "aa".repeat(32);
  const doc = {
    [alice]: { name: "Alice" },
    // A flat namestore edge: a scalar-string wrapper carrying its text in
    // `val`, exactly how one reads back out of an Automerge document.
    "todos/groceries": { val: "automerge:2AbCdEf" },
    // The certificate list: an array, not an entry.
    ".well-known/onomancy/certificates": [new Uint8Array([1, 2, 3])],
    // The legacy nested container.
    onomancy: { "old/name": "automerge:2AbCdEf" },
  };
  const directory = createAutomergeDocDirectory(doc, undefined);

  assert.deepEqual(
    directory.list().map((entry) => entry.id),
    [alice],
    "exactly the entries, nothing spread from an edge or a list"
  );
  assert.equal(directory.lookup("todos/groceries"), undefined);
  assert.equal(
    directory.lookup(".well-known/onomancy/certificates"),
    undefined
  );
  assert.equal(directory.lookup("onomancy"), undefined);
  assert.equal(directory.lookup(alice)?.name, "Alice");
});
