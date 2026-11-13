import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../../scripts/register-pi-host-typebox.mjs";
import { contentVersion, planContextBoundary, restoreContextState } from "../../src/context-core.mjs";

export const { SessionManager } = await import(new URL("dist/core/session-manager.js", pathToFileURL(`${piRoot}/`)));
let nextCall = 0;

export function appendDrafts(manager, drafts) {
  for (const draft of drafts) {
    switch (draft.type) {
      case "compaction": manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 0, draft.details, true); break;
      case "context_edit": manager.appendContextEdit(draft.targetId, draft.replacement); break;
      case "custom_message": manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details); break;
      case "custom": manager.appendCustomEntry(draft.customType, draft.data); break;
      default: throw new Error(`Unsupported boundary draft ${draft.type}`);
    }
  }
}

export function contextPreview(manager, drafts = []) {
  const projected = drafts.length
    ? SessionManager.inMemory(manager.getCwd(), undefined, [manager.getHeader(), ...manager.getBranch()])
    : manager;
  if (drafts.length) appendDrafts(projected, drafts);
  const projection = projected.buildSessionProjection();
  return {
    contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: projection.messages,
    pendingMessages: [], canContinue: projection.messages.at(-1)?.role !== "assistant",
  };
}

export function queueOperation(manager, parameters, options = {}) {
  const callId = options.callId ?? `context-${++nextCall}`;
  const operation = { expectedRevision: restoreContextState(manager.getBranch()).revision, ...parameters };
  const message = {
    role: "assistant", content: [{ type: "toolCall", id: callId, name: "compass_context", arguments: operation }],
    api: "test", provider: "test", model: "test", usage: {}, stopReason: options.outcome === "aborted" ? "aborted" : "toolUse", timestamp: Date.now(),
  };
  const result = {
    role: "toolResult", toolCallId: callId, toolName: "compass_context", content: [{ type: "text", text: "queued" }],
    details: { contextOperation: operation }, isError: false, timestamp: Date.now(),
  };
  const messageEntryId = manager.appendMessage(message);
  const resultId = manager.appendMessage(result);
  const entries = options.entries ?? [];
  return {
    type: "turn_end", turnIndex: 0, outcome: options.outcome ?? "completed", entries, continue: false,
    message, toolResults: [result], messageEntryId, toolResultEntryIds: [resultId], context: contextPreview(manager, entries),
  };
}

export function applyOperation(manager, operation, options) {
  const boundary = queueOperation(manager, operation, options);
  const planned = planContextBoundary({ state: restoreContextState(manager.getBranch()), branch: manager.getBranch(), boundary });
  assert.ok(planned, "operation must produce a boundary proposal");
  appendDrafts(manager, [...boundary.entries, ...planned.entries]);
  return { boundary, planned, state: restoreContextState(manager.getBranch()) };
}

export function sourceVersion(manager, id) {
  const entry = manager.buildSessionProjection().entries.find((item) => item.sourceEntry.id === id);
  assert.ok(entry?.messages.length, `source ${id} must be visible`);
  return contentVersion(entry.messages[0].content);
}
export function modelText(manager) { return JSON.stringify(manager.buildSessionProjection().messages); }
export function user(manager, content) { return manager.appendMessage({ role: "user", content, timestamp: Date.now() }); }
export function value(manager, content) { return manager.appendCustomMessageEntry("test-value", content, false); }

export function toolExchange(manager, names = ["read", "read"]) {
  const calls = names.map((name, index) => ({ type: "toolCall", id: `exchange-${++nextCall}-${index}`, name, arguments: { path: `source-${index}` } }));
  const assistant = manager.appendMessage({ role: "assistant", content: calls, api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
  const results = calls.map((call) => manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: call.arguments.path }], isError: false, timestamp: Date.now() }));
  return { assistant, results, ids: [assistant, ...results] };
}

export function assertPaired(manager) {
  const calls = new Map();
  const results = new Set();
  for (const message of manager.buildSessionProjection().messages) {
    if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part.name);
    if (message.role === "toolResult") {
      assert.equal(calls.get(message.toolCallId), message.toolName, `orphan result ${message.toolCallId}`);
      assert.ok(!results.has(message.toolCallId), `duplicate result ${message.toolCallId}`);
      results.add(message.toolCallId);
    }
  }
  assert.deepEqual(new Set(calls.keys()), results, "each visible call must have one result");
}
