import test from "node:test";
import assert from "node:assert/strict";
import { agentSearch, agentContextOperation } from "../src/context-agent.mjs";
import { restoreContextState } from "../src/context-core.mjs";
import { SessionManager, applyOperation, contextPreview, value } from "./helpers/context-host.mjs";
const context = (m) => ({ context: contextPreview(m) });
const state = (m) => restoreContextState(m.getBranch());
const find = (m, options = {}) => agentSearch(m.getBranch(), context(m), state(m), options);
const intent = (m, input) => agentContextOperation(m.getBranch(), context(m), state(m), input);
const apply = (m, input) => applyOperation(m, intent(m, input));

test("opaque selections cannot update a newer head or redirect multi-value moves into private copies", () => {
  for (const action of ["pin", "drop", "move"]) {
    const m = SessionManager.inMemory("/agent-contract");
    value(m, "old value");
    const old = find(m).hits[0].ref;
    apply(m, { action: "replace", source: old, text: "new value" });
    const before = state(m);
    assert.throws(() => apply(m, { action, sources: [old] }), /changed|stale/);
    assert.deepEqual(state(m), before);
  }
  const m = SessionManager.inMemory("/agent-contract");
  value(m, "first"); value(m, "second");
  const roots = find(m).hits.map((hit) => hit.ref);
  apply(m, { action: "pin", sources: roots });
  apply(m, { action: "call", task: "private", capture: roots.map((ref) => ({ ref, mode: "copy" })) });
  const before = state(m);
  assert.throws(() => apply(m, { action: "move", sources: roots }), /Pinned|explicit ref/);
  assert.deepEqual(state(m), before);
});

test("known refs resolve before pagination and recover omitted exact versions", () => {
  const m = SessionManager.inMemory("/agent-contract");
  value(m, "original payload");
  const original = find(m).hits[0].ref;
  apply(m, { action: "replace", source: original, text: "new payload" });
  assert.equal(find(m, { refs: [original], limit: 1 }).hits[0]?.text, "original payload");
  m.appendCompaction("summary", null, 0, {}, true);
  assert.equal(find(m, { refs: [original], limit: 1 }).hits[0]?.text, "original payload");
});

test("remembered claims keep authorship, exact provenance and lifetime across load/export", () => {
  const m = SessionManager.inMemory("/agent-contract");
  value(m, "observed source");
  const source = find(m).hits[0].ref;
  assert.throws(() => applyOperation(m, { ...intent(m, { action: "remember", text: "claim", sources: [source], lifetime: "goal" }), goalVersion: 0 }), /Goal/);
  apply(m, { action: "remember", text: "derived claim", sources: [source], caveats: ["Unverified."], lifetime: "session" });
  const remembered = find(m, { query: "derived claim", view: "details" }).hits[0];
  assert.equal(remembered.type, "agent-derived");
  assert.deepEqual(remembered.from, [source]);
  apply(m, { action: "load", source: remembered.ref });
  const copies = find(m, { query: "derived claim", view: "details" }).hits;
  assert.ok(copies.length >= 2);
  assert.ok(copies.every((hit) => hit.type === "agent-derived"));
  const entered = apply(m, { action: "call", task: "private note", capture: [{ ref: remembered.ref, mode: "copy" }] });
  const privateRef = JSON.parse(entered.planned.entries.findLast((entry) => entry.customType === "pi-compass-v2.context-message").content).sources[0];
  const changed = apply(m, { action: "replace", source: privateRef, text: "derived claim revised", caveats: [] });
  const updated = JSON.parse(changed.planned.entries.findLast((entry) => entry.customType === "pi-compass-v2.context-message").content).updated;
  assert.equal(typeof updated, "string");
  assert.throws(() => apply(m, { action: "return", exportSources: [privateRef] }), /changed|stale/);
  apply(m, { action: "return", exportSources: [updated] });
  const exported = find(m, { query: "revised", view: "details" }).hits;
  assert.equal(exported.length, 1);
  assert.ok(exported.every((hit) => hit.type === "agent-derived" && hit.caveats.includes("Unverified.")));
});
