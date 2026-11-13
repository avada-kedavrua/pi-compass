import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import extensionFactory from "../src/index.ts";
import { contentVersion, restoreContextState } from "../src/context-core.mjs";

const { SessionManager } = await import(new URL("dist/core/session-manager.js", pathToFileURL(`${piRoot}/`)));

function fakePi(sessionManager) {
  const events = new Map();
  const tools = new Map();
  let active = ["read", "bash", "edit", "write", "amend", "codemode", "subagent", "watch", "watches", "unwatch", "ask_user_questions"];
  return {
    events,
    tools,
    on(name, handler) { events.set(name, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    getActiveTools() { return [...active]; },
    getAllTools() { return [...active, ...tools.keys()].map((name) => ({ name })); },
    setActiveTools(names) { active = [...names]; },
    appendEntry(customType, data) { return sessionManager.appendCustomEntry(customType, structuredClone(data)); },
  };
}
function contextFor(sessionManager) {
  return { cwd: "/tmp/context-integration", sessionManager, ui: { notify() {} } };
}
function preview(sessionManager) {
  const projection = sessionManager.buildSessionProjection();
  return { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: projection.messages, pendingMessages: [], canContinue: true };
}
function messagePair(sessionManager, callId, operation, stopReason = "toolUse") {
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "compass_context", arguments: operation }],
    api: "test", provider: "test", model: "test", usage: {}, stopReason, timestamp: Date.now(),
  };
  const result = {
    role: "toolResult", toolCallId: callId, toolName: "compass_context", content: [{ type: "text", text: "queued" }],
    isError: false, details: { contextOperation: { ...operation, callId } }, timestamp: Date.now(),
  };
  const messageEntryId = sessionManager.appendMessage(message);
  const resultEntryId = sessionManager.appendMessage(result);
  return { message, result, messageEntryId, resultEntryId };
}
function applyDrafts(sessionManager, drafts) {
  for (const draft of drafts) {
    if (draft.type === "compaction") sessionManager.appendCompaction(draft.summary, draft.firstKeptEntryId, 0, draft.details, true);
    else if (draft.type === "context_edit") sessionManager.appendContextEdit(draft.targetId, draft.replacement);
    else if (draft.type === "custom_message") sessionManager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
    else if (draft.type === "custom") sessionManager.appendCustomEntry(draft.customType, draft.data);
  }
}

test("extension commits same-session frame transitions at the native turn boundary", async () => {
  const sessionManager = SessionManager.inMemory("/tmp/context-integration");
  const pi = fakePi(sessionManager);
  extensionFactory(pi);
  const ctx = contextFor(sessionManager);
  await pi.events.get("session_start")({}, ctx);
  await pi.events.get("before_agent_start")({ prompt: "Goal: inspect one source without losing the parent context." }, ctx);
  const parentId = sessionManager.appendMessage({ role: "user", content: "PARENT ONLY", timestamp: Date.now() });
  const tool = pi.tools.get("compass_context");
  assert.ok(tool, "context tool is registered");
  const callParams = { action: "call", expectedRevision: 0, task: "Inspect the selected source", capture: [] };
  const toolResult = await tool.execute("call-1", callParams, undefined, undefined, ctx);
  const call = messagePair(sessionManager, "call-1", callParams);
  call.result.details = toolResult.details;
  const callBoundary = await pi.events.get("turn_end")({
    outcome: "completed", entries: [], continue: false, message: call.message, toolResults: [call.result],
    messageEntryId: call.messageEntryId, toolResultEntryIds: [call.resultEntryId], context: preview(sessionManager),
  }, ctx);
  assert.equal(callBoundary.continue, true);
  applyDrafts(sessionManager, callBoundary.entries);
  await pi.events.get("context")({ messages: [] }, ctx);
  let text = JSON.stringify(sessionManager.buildSessionProjection().messages);
  assert.doesNotMatch(text, /PARENT ONLY/);
  assert.match(text, /Inspect the selected source/);
  assert.equal(restoreContextState(sessionManager.getBranch()).frames.length, 1);

  const state = restoreContextState(sessionManager.getBranch());
  const returnParams = { action: "return", expectedRevision: state.revision, exportIds: [], result: "finished" };
  const returnToolResult = await tool.execute("return-1", returnParams, undefined, undefined, ctx);
  const returned = messagePair(sessionManager, "return-1", returnParams);
  returned.result.details = returnToolResult.details;
  const returnBoundary = await pi.events.get("turn_end")({
    outcome: "completed", entries: [], continue: false, message: returned.message, toolResults: [returned.result],
    messageEntryId: returned.messageEntryId, toolResultEntryIds: [returned.resultEntryId], context: preview(sessionManager),
  }, ctx);
  assert.equal(returnBoundary.continue, true);
  applyDrafts(sessionManager, returnBoundary.entries);
  await pi.events.get("context")({ messages: [] }, ctx);
  text = JSON.stringify(sessionManager.buildSessionProjection().messages);
  assert.match(text, /PARENT ONLY/);
  assert.match(text, /finished/);
  assert.doesNotMatch(text, /Inspect the selected source/);
  assert.equal(restoreContextState(sessionManager.getBranch()).frames.length, 0);
  assert.ok(sessionManager.getEntry(parentId));
  assert.equal(contentVersion("PARENT ONLY").length, 24);
});
