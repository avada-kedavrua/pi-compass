import test from "node:test";
import assert from "node:assert/strict";
import { planContextBoundary, restoreContextState, searchContext } from "../src/context-core.mjs";
import { SessionManager, applyOperation, assertPaired, contextPreview, modelText, queueOperation, sourceVersion, toolExchange, user, value } from "./helpers/context-host.mjs";

function host() { const manager = SessionManager.inMemory("/context-values"); user(manager, "parent"); return manager; }
function capture(manager, id, mode) { return { id, mode, version: sourceVersion(manager, id) }; }
function search(manager, id) { return searchContext(manager.getBranch(), { context: contextPreview(manager) }, restoreContextState(manager.getBranch()), { ids: [id] }).hits[0]; }

test("an inner copy cannot write through an outer ref binding", () => {
  const manager = host();
  const id = value(manager, "original");
  applyOperation(manager, { action: "call", task: "outer", capture: [capture(manager, id, "ref")] });
  applyOperation(manager, { action: "call", task: "inner private", capture: [capture(manager, id, "copy")] });
  applyOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "private mutation" });
  applyOperation(manager, { action: "return" });
  assert.match(modelText(manager), /original/);
  assert.doesNotMatch(modelText(manager), /private mutation/);
  applyOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "shared mutation" });
  applyOperation(manager, { action: "return" });
  assert.match(modelText(manager), /shared mutation/);
  assertPaired(manager);
});

test("an inner ref can update an outer private copy without updating its source", () => {
  const manager = host();
  const id = value(manager, "original");
  applyOperation(manager, { action: "call", task: "outer private", capture: [capture(manager, id, "copy")] });
  applyOperation(manager, { action: "call", task: "inner shared", capture: [capture(manager, id, "ref")] });
  applyOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "private shared mutation" });
  applyOperation(manager, { action: "return" });
  assert.equal(search(manager, id).excerpt, "private shared mutation");
  applyOperation(manager, { action: "return" });
  assert.equal(search(manager, id).excerpt, "original");
  assert.doesNotMatch(modelText(manager), /private shared mutation/);
});

test("copy-on-write does not overwrite a simultaneously visible parent pin", () => {
  for (const create of [value, user]) {
    const manager = host();
    const id = create(manager, "original pinned value");
    applyOperation(manager, { action: "pin", ids: [id], caveats: ["Preserve the original qualification."] });
    applyOperation(manager, { action: "call", task: "private", capture: [capture(manager, id, "copy")] });
    applyOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "private value" });
    assert.match(modelText(manager), /original pinned value/);
    assert.match(modelText(manager), /private value/);
    assert.deepEqual(search(manager, id).caveats, ["Preserve the original qualification."]);
    applyOperation(manager, { action: "return" });
    assert.doesNotMatch(modelText(manager), /private value/);
    assert.equal(search(manager, id).excerpt, "original pinned value");
  }
});

test("drop rejects an expired private binding instead of deleting the root value", () => {
  const manager = host();
  const id = value(manager, "keep root value");
  applyOperation(manager, { action: "call", task: "private", capture: [capture(manager, id, "copy")] });
  const selected = search(manager, id);
  applyOperation(manager, { action: "return" });
  const boundary = queueOperation(manager, { action: "drop", ids: [id], binding: selected.binding, versions: [{ id, version: selected.version }] });
  const before = manager.getEntries().length;
  assert.throws(() => planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary }), /binding is not in an active scope/);
  assert.equal(manager.getEntries().length, before);
  assert.match(modelText(manager), /keep root value/);
});

test("derived writes and exports retain structured caveats and provenance", () => {
  const manager = host();
  const id = toolExchange(manager, ["read"]).results[0];
  applyOperation(manager, { action: "pin", ids: [id], kind: "memory", caveats: ["Local evidence only; no provider acceptance."] });
  applyOperation(manager, { action: "unpin", ids: [id] });
  applyOperation(manager, { action: "call", task: "derive", capture: [capture(manager, id, "ref")] });
  applyOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "derived conclusion" });
  assert.match(modelText(manager), /Agent-authored derived value/);
  const derivedHit = search(manager, id);
  assert.equal(derivedHit.role, "toolResult");
  assert.equal(derivedHit.authorship, "agent-derived");
  assert.equal(derivedHit.derived, true);
  assert.match(derivedHit.qualification, /not a new tool observation/);
  applyOperation(manager, { action: "return", exportIds: [id] });
  const hit = search(manager, id);
  assert.deepEqual(hit.caveats, ["Local evidence only; no provider acceptance."]);
  assert.deepEqual(hit.sources, [id]);
  const exported = manager.getBranch().findLast((entry) => entry.type === "custom_message" && entry.details?.action === "export");
  assert.deepEqual(exported.details.caveats, hit.caveats);
  assert.match(JSON.stringify(exported.content), /Local evidence only; no provider acceptance/);
  const state = restoreContextState(manager.getBranch());
  assert.ok(!JSON.stringify(state.values).includes("derived conclusion"), "control state stores a value reference, not the body");
});

test("a private multimodal Human copy can change without rewriting the original record", () => {
  const manager = host();
  const content = [{ type: "text", text: "Original Human image" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
  const id = user(manager, content);
  const raw = structuredClone(manager.getEntry(id));
  applyOperation(manager, { action: "call", task: "work with a private value", capture: [capture(manager, id, "copy")] });
  applyOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "private interpretation" });
  applyOperation(manager, { action: "return" });
  assert.deepEqual(manager.getEntry(id), raw);
  assert.deepEqual(manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id).messages[0].content, content);
  assert.doesNotMatch(modelText(manager), /private interpretation/);
});

test("an external view edit cannot be overwritten through a stale adopted value", () => {
  const manager = host();
  const id = value(manager, "original");
  applyOperation(manager, { action: "call", task: "shared", capture: [capture(manager, id, "ref")] });
  const version = sourceVersion(manager, id);
  manager.appendContextEdit(id, { content: "external context change" });
  const boundary = queueOperation(manager, { action: "replace", ids: [id], version, content: "stale write" });
  const before = manager.getEntries().length;
  assert.throws(() => planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary }), /changed externally/);
  assert.equal(manager.getEntries().length, before);
});
