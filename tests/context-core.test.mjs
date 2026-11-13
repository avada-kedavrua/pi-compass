import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import {
  contentVersion,
  emptyContextState,
  planContextBoundary,
  planWatchBoundary,
  restoreContextState,
} from "../src/context-core.mjs";

const { SessionManager } = await import(new URL("dist/core/session-manager.js", pathToFileURL(`${piRoot}/`)));

function boundary(sm, message, toolResult, messageEntryId, toolResultEntryIds, outcome = "completed") {
  return {
    outcome,
    entries: [],
    continue: false,
    message,
    toolResults: [toolResult],
    messageEntryId,
    toolResultEntryIds,
    context: (() => {
      const projection = sm.buildSessionProjection();
      return { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: projection.messages, pendingMessages: [], canContinue: true };
    })(),
  };
}
function appendDrafts(sm, drafts) {
  for (const draft of drafts) {
    if (draft.type === "compaction") sm.appendCompaction(draft.summary, draft.firstKeptEntryId, 0, draft.details, true);
    else if (draft.type === "context_edit") sm.appendContextEdit(draft.targetId, draft.replacement);
    else if (draft.type === "custom_message") sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
    else if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
    else throw new Error(`Unsupported draft ${draft.type}`);
  }
}
function contextCall(sm, operation, label = "call", outcome = "completed") {
  const callId = `${label}-call`;
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "compass_context", arguments: operation }],
    api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now(),
  };
  const result = {
    role: "toolResult", toolCallId: callId, toolName: "compass_context", content: [{ type: "text", text: "queued" }],
    isError: false, details: { contextOperation: { ...operation, callId } }, timestamp: Date.now(),
  };
  const messageEntryId = sm.appendMessage(message);
  const resultEntryId = sm.appendMessage(result);
  return { message, result, messageEntryId, resultEntryId, boundary: boundary(sm, message, result, messageEntryId, [resultEntryId], outcome) };
}
function user(sm, content) { return sm.appendMessage({ role: "user", content, timestamp: Date.now() }); }
function selectedVersion(call, id) {
  return contentVersion(call.boundary.context.contextEntries.find((item) => item.sourceEntry.id === id).messages[0].content);
}

test("same-session call switches the native projection and stores metadata only", () => {
  const sm = SessionManager.inMemory("/context-core");
  sm.appendMessage({ role: "system", content: "RESERVED SYSTEM", timestamp: Date.now() });
  user(sm, "PARENT PRIVATE CONTEXT");
  const publicId = user(sm, "PINNED REQUIREMENT");
  const call = contextCall(sm, { action: "call", expectedRevision: 0, task: "Work only on the selected source.", capture: [{ id: publicId, mode: "ref", version: "" }] });
  call.result.details.contextOperation.capture[0].version = selectedVersion(call, publicId);
  const planned = planContextBoundary({ state: emptyContextState(), branch: sm.getBranch(), boundary: call.boundary });
  appendDrafts(sm, planned.entries);
  const reloaded = SessionManager.inMemory("/context-core", undefined, sm.getEntries());
  assert.equal(restoreContextState(reloaded.getBranch()).frames.length, 1, "frame metadata reloads from the active branch");
  const projection = sm.buildSessionProjection();
  const text = JSON.stringify(projection.messages);
  assert.match(text, /RESERVED SYSTEM/);
  assert.match(text, /PINNED REQUIREMENT/);
  assert.match(text, /Work only on the selected source/);
  assert.doesNotMatch(text, /PARENT PRIVATE CONTEXT/);
  assert.equal(sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-compass-v2.context").length, 1);
  assert.deepEqual(restoreContextState(sm.getBranch()).frames.map((frame) => frame.id), ["call-call"]);
  assert.ok(!projection.messages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("compass_context")));
});

test("ref replacement persists through an aborted turn", () => {
  const sm = SessionManager.inMemory("/context-core");
  const sourceId = sm.appendCustomMessageEntry("test-slot", "mutable slot", false);
  const call = contextCall(sm, { action: "call", expectedRevision: 0, task: "Edit the slot", capture: [{ id: sourceId, mode: "ref", version: "" }] });
  call.result.details.contextOperation.capture[0].version = selectedVersion(call, sourceId);
  appendDrafts(sm, planContextBoundary({ state: emptyContextState(), branch: sm.getBranch(), boundary: call.boundary }).entries);
  const state = restoreContextState(sm.getBranch());
  const replacement = contextCall(sm, { action: "replace", expectedRevision: state.revision, ids: [sourceId], version: state.frames[0].refs[0].version, content: "updated slot" }, "replace", "aborted");
  replacement.result.details.contextOperation.version = selectedVersion(replacement, sourceId);
  const written = planContextBoundary({ state, branch: sm.getBranch(), boundary: replacement.boundary });
  assert.equal(written.continue, false, "aborted turns must not request a continuation");
  appendDrafts(sm, written.entries);
  assert.match(JSON.stringify(sm.buildSessionProjection().messages), /updated slot/);
  assert.equal(restoreContextState(sm.getBranch()).frames.length, 1);
});

test("return restores the parent after an external native compaction", () => {
  const sm = SessionManager.inMemory("/context-core");
  const parentId = user(sm, "parent survives compaction");
  const call = contextCall(sm, { action: "call", expectedRevision: 0, task: "compact child", capture: [] });
  const entered = planContextBoundary({ state: emptyContextState(), branch: sm.getBranch(), boundary: call.boundary });
  appendDrafts(sm, entered.entries);
  const childNote = sm.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === "pi-compass-v2.context-message");
  assert.ok(childNote);
  sm.appendCompaction("child work summarized", childNote.id, 0, { source: "native-test" }, true);
  const state = restoreContextState(sm.getBranch());
  const returned = contextCall(sm, { action: "return", expectedRevision: state.revision, exportIds: [], result: "restored" }, "compaction-return");
  const planned = planContextBoundary({ state, branch: sm.getBranch(), boundary: returned.boundary });
  appendDrafts(sm, planned.entries);
  const text = JSON.stringify(sm.buildSessionProjection().messages);
  assert.match(text, /parent survives compaction/);
  assert.match(text, /restored/);
  assert.doesNotMatch(text, /compact child/);
  assert.equal(restoreContextState(sm.getBranch()).frames.length, 0);
  assert.ok(sm.getEntry(parentId));
});

test("nested frames restore the immediate parent before the outer frame", () => {
  const sm = SessionManager.inMemory("/context-core");
  const sourceId = user(sm, "outer source");
  const outer = contextCall(sm, { action: "call", expectedRevision: 0, task: "outer", capture: [{ id: sourceId, mode: "ref", version: "" }] });
  outer.result.details.contextOperation.capture[0].version = selectedVersion(outer, sourceId);
  appendDrafts(sm, planContextBoundary({ state: emptyContextState(), branch: sm.getBranch(), boundary: outer.boundary }).entries);
  let state = restoreContextState(sm.getBranch());
  const nested = contextCall(sm, { action: "call", expectedRevision: state.revision, task: "nested", capture: [] }, "nested");
  const nestedPlan = planContextBoundary({ state, branch: sm.getBranch(), boundary: nested.boundary });
  appendDrafts(sm, nestedPlan.entries);
  state = restoreContextState(sm.getBranch());
  assert.equal(state.frames.length, 2);
  const nestedReturn = contextCall(sm, { action: "return", expectedRevision: state.revision, exportIds: [], result: "nested done" }, "nested-return");
  const restoredOuter = planContextBoundary({ state, branch: sm.getBranch(), boundary: nestedReturn.boundary });
  appendDrafts(sm, restoredOuter.entries);
  state = restoreContextState(sm.getBranch());
  assert.deepEqual(state.frames.map((frame) => frame.id), ["call-call"]);
  assert.match(JSON.stringify(sm.buildSessionProjection().messages), /nested done/);
});

test("frame-owned watches block return until pi-await reports cancellation", () => {
  const sm = SessionManager.inMemory("/context-core");
  const sourceId = user(sm, "source");
  const call = contextCall(sm, { action: "call", expectedRevision: 0, task: "watch", capture: [{ id: sourceId, mode: "ref", version: "" }] });
  call.result.details.contextOperation.capture[0].version = selectedVersion(call, sourceId);
  appendDrafts(sm, planContextBoundary({ state: emptyContextState(), branch: sm.getBranch(), boundary: call.boundary }).entries);
  let state = restoreContextState(sm.getBranch());
  const watchResult = { role: "toolResult", toolCallId: "watch-call", toolName: "watch", content: [{ type: "text", text: JSON.stringify({ id: "w1", status: "armed" }) }], details: { id: "w1", status: "armed" }, isError: false };
  const watchPlan = planWatchBoundary({ state, boundary: { toolResults: [watchResult] } });
  assert.ok(watchPlan);
  state = watchPlan.state;
  assert.equal(state.watches.w1.owner, "call-call");
  const returnCall = contextCall(sm, { action: "return", expectedRevision: state.revision, exportIds: [] }, "blocked-return");
  assert.throws(() => planContextBoundary({ state, branch: sm.getBranch(), boundary: returnCall.boundary }), /Frame owns active watches/);
  const unwatchResult = { role: "toolResult", toolCallId: "unwatch-call", toolName: "unwatch", content: [{ type: "text", text: JSON.stringify({ cancelled: 1 }) }], details: { cancelledIds: ["w1"] }, isError: false };
  state = planWatchBoundary({ state, boundary: { toolResults: [unwatchResult] } }).state;
  assert.deepEqual(state.watches, {});
});

test("return restores parent projection, preserves Human steering, and exports explicitly", () => {
  const sm = SessionManager.inMemory("/context-core");
  user(sm, "PARENT CONTEXT");
  const sourceId = user(sm, "selected input");
  const call = contextCall(sm, { action: "call", expectedRevision: 0, task: "inspect", capture: [{ id: sourceId, mode: "ref", version: "" }] });
  call.result.details.contextOperation.capture[0].version = selectedVersion(call, sourceId);
  appendDrafts(sm, planContextBoundary({ state: emptyContextState(), branch: sm.getBranch(), boundary: call.boundary }).entries);
  const childMessageId = user(sm, "Human steering must survive");
  const state = restoreContextState(sm.getBranch());
  const returned = contextCall(sm, { action: "return", expectedRevision: state.revision, exportIds: [sourceId], result: "done" }, "return");
  const planned = planContextBoundary({ state, branch: sm.getBranch(), boundary: returned.boundary });
  appendDrafts(sm, planned.entries);
  const text = JSON.stringify(sm.buildSessionProjection().messages);
  assert.match(text, /PARENT CONTEXT/);
  assert.match(text, /Human steering must survive/);
  assert.match(text, /selected input/);
  assert.match(text, /done/);
  assert.doesNotMatch(text, /inspect/);
  assert.equal(restoreContextState(sm.getBranch()).frames.length, 0);
  assert.ok(sm.getEntry(childMessageId));
});
