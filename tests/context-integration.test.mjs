import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import extensionFactory from "../src/index.ts";
import { emptyContextState, planWatchBoundary, restoreContextState } from "../src/context-core.mjs";
import { SessionManager, appendDrafts, assertPaired, contextPreview, modelText, user } from "./helpers/context-host.mjs";

const { ExtensionRunner } = await import(new URL("dist/core/extensions/runner.js", pathToFileURL(`${piRoot}/`)));
let nextCall = 0;

// Real installed boundary chaining and session projection; tool registry/lifecycle
// actions are adapters. This is not a live AgentSession/provider acceptance test.
async function setup(laterHandler) {
  const manager = SessionManager.inMemory("/context-integration");
  const handlers = new Map();
  const tools = new Map();
  let active = ["read", "bash", "codemode", "watch", "watches", "unwatch"];
  const api = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    getActiveTools() { return [...active]; },
    getAllTools() { return [...new Set([...active, ...tools.keys()])].map((name) => ({ name })); },
    setActiveTools(names) { active = [...names]; },
    appendEntry(type, data) { return manager.appendCustomEntry(type, structuredClone(data)); },
  };
  extensionFactory(api);
  const extensions = [{ path: "compass", handlers }];
  if (laterHandler) extensions.push({ path: "later-extension", handlers: new Map([["turn_end", [laterHandler]]]) });
  const runner = new ExtensionRunner(extensions, {}, "/context-integration", manager, undefined);
  const errors = [];
  let aborted = false;
  runner.errorListeners.add((error) => errors.push(error));
  runner.abortFn = () => { aborted = true; };
  await runner.emit({ type: "session_start" });
  // Goal capture itself is unrelated to native provider execution.
  await handlers.get("before_agent_start")[0]({ prompt: "Goal: preserve parent context while working locally." }, runner.createContext());
  user(manager, "PARENT ONLY");
  async function turn(parameters, { apply = true } = {}) {
    const id = `integration-${++nextCall}`;
    const message = {
      role: "assistant", content: [{ type: "toolCall", id, name: "compass_context", arguments: parameters }],
      api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now(),
    };
    const messageEntryId = manager.appendMessage(message);
    const output = await tools.get("compass_context").execute(id, parameters, undefined, undefined, runner.createContext());
    const result = { role: "toolResult", toolCallId: id, toolName: "compass_context", ...output, timestamp: Date.now() };
    const resultEntryId = manager.appendMessage(result);
    const proposal = await runner.emitBoundary({
      type: "turn_end", turnIndex: 0, outcome: "completed", message, toolResults: [result],
      messageEntryId, toolResultEntryIds: [resultEntryId],
    }, (drafts) => contextPreview(manager, drafts));
    assert.equal(proposal.valid, true);
    if (apply) appendDrafts(manager, proposal.entries);
    return proposal;
  }
  return { manager, runner, tools, turn, errors, aborted: () => aborted };
}

test("installed runner chains frame entry and return; only committed metadata becomes active", async () => {
  const host = await setup();
  const { manager, tools, runner } = host;
  const proposal = await host.turn({ action: "call", expectedRevision: 0, task: "LOCAL PROCEDURE" }, { apply: false });
  assert.deepEqual(restoreContextState(manager.getBranch()), emptyContextState(), "returning drafts is not committing them");
  const beforeCommit = await tools.get("compass_context").execute("read-state", { action: "search", expectedRevision: 0 }, undefined, undefined, runner.createContext());
  assert.equal(JSON.parse(beforeCommit.content[0].text).revision, 0);
  appendDrafts(manager, proposal.entries);
  await runner.emitContext(manager.buildSessionProjection().messages);
  assert.match(modelText(manager), /LOCAL PROCEDURE/);
  assert.doesNotMatch(modelText(manager), /PARENT ONLY/);
  assertPaired(manager);
  const returned = await host.turn({ action: "return", expectedRevision: 1, result: "SELECTED RESULT" });
  assert.equal(returned.continue, true);
  assert.match(modelText(manager), /PARENT ONLY/);
  assert.match(modelText(manager), /SELECTED RESULT/);
  assert.doesNotMatch(modelText(manager), /LOCAL PROCEDURE/);
  assertPaired(manager);
  assert.deepEqual(host.errors, []);
});

test("a later handler altering a context proposal is detected and invokes the public abort action", async () => {
  const host = await setup((event) => {
    const entries = structuredClone(event.entries);
    const edit = entries.find((entry) => entry.type === "context_edit");
    if (edit) edit.replacement = { content: "altered proposal" };
    return { entries };
  });
  await host.turn({ action: "call", expectedRevision: 0, task: "local" });
  await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.equal(host.aborted(), true, "hook exceptions alone are not a fail-closed policy");
  assert.ok(host.errors.some((error) => /changed|persisted/.test(error.error)));
});

test("steering and native watch wakes reconcile a newly committed frame before persisting ownership", async () => {
  for (const native of [false, true]) {
    const host = await setup();
    const watch = planWatchBoundary({ state: emptyContextState(), boundary: { toolResults: [{ toolName: "watch", details: { id: "w1", status: "armed" }, content: [] }] } });
    appendDrafts(host.manager, watch.entries);
    await host.runner.emitContext(host.manager.buildSessionProjection().messages);
    await host.turn({ action: "call", expectedRevision: 1, task: "committed frame" });
    // Deliberately no context hook between commit and message_end.
    const content = "WATCH_SETTLED:match\nid: w1";
    const entryId = native ? host.manager.appendCustomMessageEntry("watch-condition", content, true) : user(host.manager, content);
    const raw = host.manager.getEntry(entryId);
    await host.runner.emit({ type: "message_end", message: native ? { role: "custom", customType: raw.customType, content: raw.content } : raw.message });
    const state = restoreContextState(host.manager.getBranch());
    assert.equal(state.frames.length, 1, "new Human/external input must not overwrite the committed frame with its prior state");
    assert.equal(Boolean(state.watches.w1), !native, "only a native watch message may release ownership");
    assert.deepEqual(host.errors, []);
  }
});

test("a later handler cannot silently change committed control metadata", async () => {
  const host = await setup((event) => {
    const entries = structuredClone(event.entries);
    const state = entries.findLast((entry) => entry.type === "custom" && entry.customType === "pi-compass-v2.context");
    if (state) state.data.frames = [];
    return { entries };
  });
  await host.turn({ action: "call", expectedRevision: 0, task: "local" });
  await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.equal(host.aborted(), true);
  assert.ok(host.errors.some((error) => /changed|persisted/.test(error.error)));
});

test("nested Code Mode mutation is blocked before returning an unexecutable queued operation", async () => {
  const host = await setup();
  const result = await host.runner.emitToolCall({
    type: "tool_call", toolName: "compass_context", toolCallId: "code/1", parentToolCallId: "code",
    input: { action: "call", expectedRevision: 0, task: "local" },
  });
  assert.equal(result?.block, true);
  assert.match(result.reason, /direct standalone/);
});
