import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_MESSAGE_TYPE, emptyContextState, normalizeContextState, planContextBoundary, planWatchBoundary, releaseWatchMessages, restoreContextState, searchContext, pinnedContextOverlay, planObservationBoundary,
} from "../src/context-core.mjs";
import {
  SessionManager, appendDrafts, applyOperation, assertPaired, contextPreview, modelText, queueOperation, sourceVersion,
  toolExchange, user, value,
} from "./helpers/context-host.mjs";

function host() {
  const manager = SessionManager.inMemory("/context-core");
  manager.appendMessage({ role: "system", content: "RESERVED SYSTEM", timestamp: Date.now() });
  return manager;
}
function capture(manager, id, mode = "ref") { return { id, mode, version: sourceVersion(manager, id) }; }

test("same-session call preserves reserved state, scopes inputs, and restores raw parent records", () => {
  const manager = host();
  const parent = user(manager, "PARENT PRIVATE CONTEXT");
  const input = value(manager, "explicit input");
  const original = structuredClone(manager.getEntry(parent));
  applyOperation(manager, { action: "call", task: "local procedure", capture: [capture(manager, input)] });
  assert.doesNotMatch(modelText(manager), /PARENT PRIVATE CONTEXT/);
  assert.match(modelText(manager), /RESERVED SYSTEM/);
  assert.match(modelText(manager), /explicit input/);
  assertPaired(manager);
  const recovered = SessionManager.inMemory("/context-core", undefined, [manager.getHeader(), ...manager.getEntries()]);
  assert.equal(restoreContextState(recovered.getBranch()).frames.length, 1);
  applyOperation(recovered, { action: "return", result: "bounded return" });
  assert.match(modelText(recovered), /PARENT PRIVATE CONTEXT/);
  assert.match(modelText(recovered), /bounded return/);
  assert.doesNotMatch(modelText(recovered), /local procedure/);
  assert.deepEqual(recovered.getEntry(parent), original);
  assert.equal(restoreContextState(recovered.getBranch()).frames.length, 0);
  assertPaired(recovered);
});

test("uncaptured parent ranges load as editable data copies with actionable export references", () => {
  const manager = host();
  const parent = user(manager, "parent first line\nrecoverable requirement\nparent last line");
  const version = sourceVersion(manager, parent);
  const original = structuredClone(manager.getEntry(parent));
  applyOperation(manager, { action: "call", task: "child without implicit input" });
  const found = searchContext(manager.getBranch(), { context: contextPreview(manager) }, restoreContextState(manager.getBranch()), { query: "recoverable", sourceScope: "parent" });
  assert.equal(found.hits[0].id, parent);
  assert.equal(found.hits[0].version, version);
  const loaded = applyOperation(manager, { action: "load", ids: [parent], version, sourceScope: "parent", range: { startLine: 2, endLine: 2 } });
  const data = loaded.planned.entries.find((entry) => entry.details?.action === "load");
  assert.match(JSON.stringify(data.content), /recoverable requirement/);
  assert.doesNotMatch(JSON.stringify(data.content), /parent first line/);
  const id = data.details.sourceId;
  applyOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "local interpretation" });
  const returned = applyOperation(manager, { action: "return", exportIds: [id] });
  const receipt = returned.planned.entries.findLast((entry) => entry.details?.references?.length);
  const exported = receipt.details.references[0];
  assert.equal(sourceVersion(manager, exported.id), exported.version);
  assert.match(modelText(manager), /local interpretation/);
  assert.deepEqual(manager.getEntry(parent), original);
  assertPaired(manager);
});

test("moving a result payload keeps its complete parallel execution envelope", () => {
  const manager = host();
  user(manager, "parent");
  const exchange = toolExchange(manager);
  const id = exchange.results[0];
  const original = structuredClone(manager.getEntry(id));
  const version = sourceVersion(manager, id);
  applyOperation(manager, { action: "move", ids: [id], version });
  assert.equal(sourceVersion(manager, id), version);
  assert.deepEqual(manager.getEntry(id), original);
  assert.match(modelText(manager), /Context relocation pointer/);
  assertPaired(manager);
  const control = restoreContextState(manager.getBranch());
  const stale = queueOperation(manager, { action: "move", ids: [id], version: "0".repeat(24) });
  const before = manager.getEntries().length;
  assert.throws(() => planContextBoundary({ state: control, branch: manager.getBranch(), boundary: stale }), /changed/);
  assert.equal(manager.getEntries().length, before);
});

test("Goal-scoped retention expires without retiring explicit session data", () => {
  const manager = host();
  user(manager, "parent");
  const goal = value(manager, "GOAL_SCOPED_FACT");
  const session = value(manager, "SESSION_SCOPED_FACT");
  applyOperation(manager, { action: "pin", ids: [goal] });
  applyOperation(manager, { action: "pin", ids: [session], lifetime: "session" });
  const state = restoreContextState(manager.getBranch());
  const overlay = pinnedContextOverlay(manager.getBranch(), state, [], 2);
  assert.match(JSON.stringify(overlay), /SESSION_SCOPED_FACT/);
  assert.doesNotMatch(JSON.stringify(overlay), /GOAL_SCOPED_FACT/);
  const planned = planObservationBoundary({ state, branch: manager.getBranch(), boundary: { context: contextPreview(manager), toolResults: [], toolResultEntryIds: [] }, goalVersion: 2 });
  appendDrafts(manager, planned.entries);
  assert.equal(planned.state.values[`root/${goal}`].handling, "retired");
  assert.deepEqual(planned.state.pins.map((pin) => pin.id), [session]);
});

test("failed Skill reads cannot be activated as successful retained instructions", () => {
  const manager = host();
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "failed-skill", name: "read", arguments: { path: "SKILL.md" } }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
  const id = manager.appendMessage({ role: "toolResult", toolCallId: "failed-skill", toolName: "read", content: [{ type: "text", text: "Read failed" }], isError: true, timestamp: Date.now() });
  const pending = queueOperation(manager, { action: "pin", ids: [id], kind: "skill" });
  const before = manager.getEntries().length;
  assert.throws(() => planContextBoundary({ state: emptyContextState(), branch: manager.getBranch(), boundary: pending }), /failed Skill read/);
  assert.equal(manager.getEntries().length, before);
});

test("return restores an existing parent summary, not a generic frame note", () => {
  const manager = host();
  const tail = user(manager, "recent parent tail");
  manager.appendCompaction("PARENT SUMMARY contains a material caveat", tail, 0);
  applyOperation(manager, { action: "call", task: "child procedure" });
  applyOperation(manager, { action: "return" });
  assert.match(modelText(manager), /PARENT SUMMARY contains a material caveat/);
});

test("native child compaction cannot resurrect released child process entries", () => {
  const manager = host();
  user(manager, "parent");
  applyOperation(manager, { action: "call", task: "child procedure" });
  value(manager, "OLD CHILD PROCESS MUST NOT RETURN");
  const childTail = value(manager, "recent child tail");
  manager.appendCompaction("native child summary", childTail, 0);
  applyOperation(manager, { action: "return", result: "selected conclusion" });
  assert.match(modelText(manager), /selected conclusion/);
  assert.doesNotMatch(modelText(manager), /OLD CHILD PROCESS|recent child tail|native child summary|child procedure/);
  assertPaired(manager);
});

test("ref writes survive abort, nested scopes, native compaction, and return", () => {
  const manager = host();
  const input = value(manager, "original value");
  applyOperation(manager, { action: "call", task: "outer", capture: [capture(manager, input)] });
  applyOperation(manager, { action: "call", task: "inner", capture: [capture(manager, input)] });
  const written = applyOperation(manager, { action: "replace", ids: [input], version: sourceVersion(manager, input), content: "updated shared value" }, { outcome: "aborted" });
  assert.equal(written.planned.continue, false);
  const tail = value(manager, "inner tail");
  manager.appendCompaction("inner summary", tail, 0);
  applyOperation(manager, { action: "return" });
  assert.equal(restoreContextState(manager.getBranch()).frames.length, 1);
  assert.match(modelText(manager), /updated shared value/);
  applyOperation(manager, { action: "return" });
  assert.match(modelText(manager), /updated shared value/);
  assert.doesNotMatch(modelText(manager), /original value|inner tail/);
});

test("frame identities use persisted source entries, not session-global provider call IDs", () => {
  const manager = host();
  user(manager, "parent");
  applyOperation(manager, { action: "call", task: "outer" }, { callId: "provider-reused-id" });
  applyOperation(manager, { action: "call", task: "inner" }, { callId: "provider-reused-id" });
  const frames = restoreContextState(manager.getBranch()).frames;
  assert.equal(new Set(frames.map((frame) => frame.id)).size, 2);
  for (const frame of frames) assert.equal(frame.id, frame.boundaryId);
  applyOperation(manager, { action: "return" });
  applyOperation(manager, { action: "return" });
  assertPaired(manager);
});

test("reference versions follow native string-to-tool-content normalization", () => {
  const manager = host();
  const exchange = toolExchange(manager, ["read"]);
  const input = exchange.results[0];
  manager.appendContextEdit(input, { content: "native replacement string" });
  applyOperation(manager, { action: "call", task: "use the current value", capture: [capture(manager, input)] });
  applyOperation(manager, { action: "return" });
  assert.match(modelText(manager), /native replacement string/);
  assertPaired(manager);
});

test("editing a captured copy does not modify its enclosing value", () => {
  const manager = host();
  const input = value(manager, "outer value");
  applyOperation(manager, { action: "call", task: "private", capture: [capture(manager, input, "copy")] });
  assert.ok(!manager.getBranch().some((entry) => entry.customType === "pi-compass-v2.value"), "unchanged generic copies do not duplicate a value body");
  applyOperation(manager, { action: "replace", ids: [input], version: sourceVersion(manager, input), content: "private changed value" });
  assert.ok(manager.getBranch().some((entry) => entry.customType === "pi-compass-v2.value"), "the private data view is created on first write");
  assert.match(modelText(manager), /private changed value/);
  applyOperation(manager, { action: "return" });
  assert.match(modelText(manager), /outer value/);
  assert.doesNotMatch(modelText(manager), /private changed value/);
});

test("capture and pin retain complete parallel tool exchanges", () => {
  const manager = host();
  user(manager, "parent");
  const exchange = toolExchange(manager);
  applyOperation(manager, { action: "pin", ids: [exchange.results[0]] });
  applyOperation(manager, { action: "call", task: "read evidence", capture: [capture(manager, exchange.results[0])] });
  assertPaired(manager);
  applyOperation(manager, { action: "return" });
  assertPaired(manager);
});

test("drop removes a complete tool exchange and rejects stale versions without appending edits", () => {
  const manager = host();
  const exchange = toolExchange(manager);
  const versions = exchange.ids.map((id) => ({ id, version: sourceVersion(manager, id) }));
  const boundary = queueOperation(manager, { action: "drop", ids: [exchange.results[0]], versions: versions.map((item) => ({ ...item, version: "0".repeat(24) })) });
  const before = manager.getEntries().length;
  assert.throws(() => planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary }), /changed|stale/i);
  assert.equal(manager.getEntries().length, before);
  applyOperation(manager, { action: "drop", ids: [exchange.results[0]], versions });
  assertPaired(manager);
  const visible = new Set(manager.buildSessionProjection().entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id));
  for (const id of exchange.ids) assert.ok(!visible.has(id));
});

test("assistant tool-call replacements and Human edits are rejected without mutation", () => {
  const manager = host();
  const human = user(manager, "material Human instruction");
  const exchange = toolExchange(manager);
  for (const id of [human, exchange.assistant]) {
    const boundary = queueOperation(manager, { action: "replace", ids: [id], version: sourceVersion(manager, id), content: "fabricated" });
    assert.throws(() => planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary }), /Human|tool.call/i);
  }
  assertPaired(manager);
});

test("branch navigation restores branch-local frames, not a higher-revision sibling", () => {
  const manager = host();
  const root = user(manager, "root");
  applyOperation(manager, { action: "call", task: "branch A" });
  const branchA = manager.getLeafId();
  applyOperation(manager, { action: "call", task: "nested A" });
  manager.branch(root);
  assert.deepEqual(restoreContextState(manager.getBranch()), emptyContextState());
  applyOperation(manager, { action: "call", task: "branch B" });
  const branchB = manager.getLeafId();
  manager.branch(branchA);
  assert.equal(restoreContextState(manager.getBranch()).frames.length, 1);
  applyOperation(manager, { action: "return" });
  assert.doesNotMatch(modelText(manager), /branch A|nested A|branch B/);
  manager.branch(branchB);
  assert.match(modelText(manager), /branch B/);
});

test("return preserves new Human steering without exporting the full child process", () => {
  const manager = host();
  user(manager, "parent");
  applyOperation(manager, { action: "call", task: "child" });
  user(manager, "Human steering must survive");
  const selected = value(manager, "explicitly exported result");
  value(manager, "discarded process");
  applyOperation(manager, { action: "return", exportIds: [selected] });
  assert.match(modelText(manager), /Human steering must survive|explicitly exported result/);
  assert.doesNotMatch(modelText(manager), /discarded process/);
});

test("owned watches block return until native cancellation; no duplicate watcher exists", () => {
  const manager = host();
  user(manager, "parent");
  applyOperation(manager, { action: "call", task: "wait" });
  const state = restoreContextState(manager.getBranch());
  const watchPlan = planWatchBoundary({ state, branch: manager.getBranch(), boundary: { toolResults: [{ toolName: "watch", toolCallId: "watch-call", details: { id: "w1", instanceId: "native-arm", status: "armed" }, content: [] }] } });
  assert.ok(watchPlan);
  appendDrafts(manager, watchPlan.entries);
  const boundary = queueOperation(manager, { action: "return" });
  assert.throws(() => planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary }), /active watches/);
  const cancelled = planWatchBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary: { toolResults: [{ toolName: "unwatch", details: { cancelledIds: ["w1"], cancelledInstanceIds: ["native-arm"] }, content: [] }] } });
  appendDrafts(manager, cancelled.entries);
  applyOperation(manager, { action: "return" });
  assert.equal(restoreContextState(manager.getBranch()).frames.length, 0);
});

test("a parent-owned native watch does not block a nested frame return", () => {
  const manager = host();
  user(manager, "parent");
  const arm = planWatchBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary: {
    toolResults: [{ toolName: "watch", details: { id: "w-parent", instanceId: "parent-arm", kind: "event", target: "user_bash", status: "armed" }, content: [] }],
  } });
  appendDrafts(manager, arm.entries);
  applyOperation(manager, { action: "call", task: "nested work" });
  applyOperation(manager, { action: "return" });
  assert.equal(restoreContextState(manager.getBranch()).watches["w-parent"].owner, "root");
  assert.equal(restoreContextState(manager.getBranch()).frames.length, 0);
});

test("native repeating wakes retain ownership until terminal or lost lifecycle", () => {
  const manager = host();
  user(manager, "parent");
  applyOperation(manager, { action: "call", task: "repeat wait" });
  const arm = planWatchBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary: {
    toolResults: [{ toolName: "watch", details: { id: "w1", instanceId: "native-repeat", kind: "event", target: "user_bash", prompt: "repeat", repeatMs: 1000, status: "armed" }, content: [] }],
  } });
  appendDrafts(manager, arm.entries);
  const repeat = planWatchBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary: { toolResults: [] } });
  assert.equal(repeat, null);
  const repeated = releaseWatchMessages(restoreContextState(manager.getBranch()), "WATCH_SETTLED:match\nid: w1\nkind: event\ntarget: user_bash\nrepeat: round 1 settled, round 2 armed (every 1000ms)");
  assert.equal(repeated, null);
  const lost = releaseWatchMessages(restoreContextState(manager.getBranch()), "WATCH_LOST: 1 watch\n  w1 [event] user_bash — repeat");
  assert.ok(lost);
  assert.equal(lost.state.watches.w1, undefined);
});

test("native cancellation uses exact arm identity and transfer releases a frame owner", () => {
  const manager = host();
  user(manager, "parent");
  applyOperation(manager, { action: "call", task: "owned wait" });
  const armed = planWatchBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary: {
    toolResults: [{ toolName: "watch", details: { id: "w1", instanceId: "arm-a", kind: "event", target: "user_bash", status: "armed" }, content: [] }],
  } });
  appendDrafts(manager, armed.entries);
  const staleCancel = planWatchBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary: { toolResults: [{ toolName: "unwatch", details: { cancelledIds: ["w1"], cancelledInstanceIds: ["arm-b"] }, content: [] }] } });
  assert.equal(staleCancel, null, "a cancellation for another native arm must not release the live watch");
  const transferBoundary = queueOperation(manager, { action: "transfer", watchIds: ["w1"], watchScope: "root" });
  const transferred = planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary: transferBoundary });
  appendDrafts(manager, [...transferBoundary.entries, ...transferred.entries]);
  assert.equal(restoreContextState(manager.getBranch()).watches.w1.owner, "root");
  applyOperation(manager, { action: "return" });
  assert.equal(restoreContextState(manager.getBranch()).frames.length, 0);
});

test("a context mutation in a parallel tool batch is rejected explicitly", () => {
  const manager = host();
  user(manager, "parent");
  const boundary = queueOperation(manager, { action: "call", task: "local" });
  boundary.message.content.push({ type: "toolCall", id: "other", name: "read", arguments: { path: "x" } });
  boundary.toolResults.push({ role: "toolResult", toolCallId: "other", toolName: "read", content: [] });
  assert.throws(() => planContextBoundary({ state: emptyContextState(), branch: manager.getBranch(), boundary }), /only|batch|standalone/i);
});

test("partial or altered boundary persistence is detected instead of activating guessed state", () => {
  for (const altered of [false, true]) {
    const manager = host();
    user(manager, "parent");
    const boundary = queueOperation(manager, { action: "call", task: "uncommitted work" });
    const before = manager.getLeafId();
    const planned = planContextBoundary({ state: emptyContextState(), branch: manager.getBranch(), boundary });
    const drafts = structuredClone(planned.entries);
    if (altered) {
      const edit = drafts.find((entry) => entry.type === "context_edit");
      edit.replacement = { content: "altered by a later handler" };
      appendDrafts(manager, drafts);
    } else appendDrafts(manager, drafts.slice(0, -1));
    assert.throws(() => restoreContextState(manager.getBranch()), /Uncommitted|changed|persisted/);
    manager.branch(before);
    assert.deepEqual(restoreContextState(manager.getBranch()), emptyContextState());
  }
});

test("boundary composition preserves preceding metadata proposals and rejects conflicting view edits", () => {
  const manager = host();
  user(manager, "parent");
  const prior = [{ type: "custom", customType: "other-extension", data: { preserved: true } }];
  applyOperation(manager, { action: "call", task: "composed" }, { entries: prior });
  assert.ok(manager.getBranch().some((entry) => entry.customType === "other-extension"));
  const source = manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.type === "custom_message" && entry.messages.length).sourceEntry.id;
  const boundary = queueOperation(manager, { action: "return" }, { entries: [{ type: "context_edit", targetId: source, replacement: null }] });
  assert.throws(() => planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary }), /Another extension/);
});

test("unsupported or malformed metadata cannot silently reset a frame", () => {
  assert.throws(() => normalizeContextState({ ...emptyContextState(), schemaVersion: 1 }), /Unsupported/);
  assert.throws(() => normalizeContextState({ ...emptyContextState(), frames: [{ id: "broken", parent: "other" }] }), /Invalid frame/);
});

test("existing hidden entries stay hidden after call and return", () => {
  const manager = host();
  user(manager, "parent");
  const omitted = value(manager, "ALREADY OMITTED");
  manager.appendContextEdit(omitted, null);
  applyOperation(manager, { action: "call", task: "local" });
  applyOperation(manager, { action: "return" });
  assert.doesNotMatch(modelText(manager), /ALREADY OMITTED/);
  assert.ok(manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === CONTEXT_MESSAGE_TYPE));
});
