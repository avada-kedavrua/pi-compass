import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const { discoverAndLoadExtensions, ExtensionRunner, SessionManager, getAgentDir } = await import(process.argv[2]);
const cwd = process.argv[4];
const loaded = await discoverAndLoadExtensions([process.argv[3]], cwd, getAgentDir());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const manager = SessionManager.inMemory(cwd);
const tools = loaded.extensions[0].tools;
let active = [...tools.keys()];
Object.assign(loaded.runtime, {
  appendEntry: (type, data) => manager.appendCustomEntry(type, data),
  getActiveTools: () => active,
  setActiveTools: (names) => { active = names; },
  getAllTools: () => [...tools.values()].map(({ definition }) => definition),
});
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, undefined);
const errors = [];
runner.onError((error) => errors.push(error));
try {
  await runner.emit({ type: "session_start" });
  const context = runner.createContext();
  assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "compass_state", toolCallId: "state", input: {} }), undefined);
  const state = await tools.get("compass_state").definition.execute("state", {}, undefined, undefined, context);
  assert.notEqual(state.isError, true);
  assert.equal(JSON.parse(state.content[0].text).frame, "root");
  manager.appendMessage({ role: "user", content: "Fix the settings permission mismatch without changing unrelated pages.", timestamp: Date.now() });
  await runner.emit({ type: "before_agent_start", prompt: "Fix the settings permission mismatch." });
  const readState = async () => JSON.parse((await tools.get("compass_state").definition.execute("state", {}, undefined, undefined, context)).content[0].text);
  const observed = await readState();
  const goal = await tools.get("compass_goal").definition.execute("goal", { action: "set", current: "Fix settings permissions", constraints: ["Do not change unrelated pages"], sources: [observed.input.ref] }, undefined, undefined, context);
  assert.equal(JSON.parse(goal.content[0].text).cursor.startsWith("R"), true);
  assert.equal(JSON.parse(goal.content[0].text).sourceIds, undefined);
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "observed-read", name: "read", arguments: { path: "settings.ts" } }], timestamp: Date.now() });
  manager.appendMessage({ role: "toolResult", toolCallId: "observed-read", toolName: "read", isError: false, content: [{ type: "text", text: "PERMISSION_EVIDENCE " + "large original body ".repeat(3000) }], timestamp: Date.now() });
  const found = JSON.parse((await tools.get("compass_context_search").definition.execute("find", { query: "PERMISSION_EVIDENCE" }, undefined, undefined, context)).content[0].text);
  assert.equal(found.hits.length, 1);
  assert.ok(JSON.stringify(found).length < 600);
  const source = found.hits[0].ref;
  function append(target, entries) {
    for (const d of entries) {
      if (d.type === "custom") target.appendCustomEntry(d.customType, d.data);
      else if (d.type === "custom_message") target.appendCustomMessageEntry(d.customType, d.content, d.display, d.details);
      else if (d.type === "context_edit") target.appendContextEdit(d.targetId, d.replacement);
      else if (d.type === "compaction") target.appendCompaction(d.summary, d.firstKeptEntryId, 0, d.details, true);
      else throw Error("unexpected draft");
    }
  }
  let sequence = 0;
  async function mutate(operation) {
    const id = "mutation-" + ++sequence;
    const input = operation;
    const message = { role: "assistant", content: [{ type: "toolCall", id, name: "compass_context", arguments: input }], timestamp: Date.now() };
    const messageEntryId = manager.appendMessage(message);
    assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "compass_context", toolCallId: id, input }), undefined);
    const queued = await tools.get("compass_context").definition.execute(id, input, undefined, undefined, context);
    assert.equal(queued.isError, undefined, JSON.stringify(queued));
    assert.deepEqual(JSON.parse(queued.content[0].text), { queued: true });
    const result = { role: "toolResult", toolCallId: id, toolName: "compass_context", ...queued, timestamp: Date.now() };
    const resultId = manager.appendMessage(result);
    const committed = await runner.emitBoundary({ type: "turn_end", turnIndex: 0, outcome: "completed", message, toolResults: [result], messageEntryId, toolResultEntryIds: [resultId], entries: [] }, (drafts) => {
      const preview = SessionManager.inMemory(cwd, undefined, [manager.getHeader(), ...manager.getBranch()]);
      append(preview, drafts);
      const p = preview.buildSessionProjection();
      return { contextEntries: p.entries, contextMessages: p.messages, llmMessages: p.messages, pendingMessages: [], canContinue: true };
    });
    assert.equal(committed.valid, true);
    append(manager, committed.entries);
    const receipt = JSON.parse(committed.entries.findLast((entry) => entry.customType === "pi-compass-v2.context-message").content);
    assert.equal(receipt.resultStatus, "applied");
    return receipt;
  }
  const saved = await mutate({ action: "remember", text: "Code shows a permission mismatch. Runtime behavior is not yet verified.", sources: [observed.input.ref, source], caveats: ["Not runtime-verified."] });
  assert.equal(saved.sources.length, 1);
  await runner.emitContext(manager.buildSessionProjection().messages);
  const entered = await mutate({ action: "call", task: "Refine a private memory copy", capture: [{ ref: saved.sources[0], mode: "copy" }] });
  const edited = await mutate({ action: "replace", source: entered.sources[0], text: "Private revised claim; runtime still pending.", caveats: [] });
  const returned = await mutate({ action: "return", exportSources: [edited.updated] });
  const lookup = async (ref) => JSON.parse((await tools.get("compass_context_search").definition.execute("exact", { refs: [ref], view: "details" }, undefined, undefined, context)).content[0].text).hits[0];
  assert.match((await lookup(saved.sources[0])).text, /Runtime behavior is not yet verified/);
  const exported = await lookup(returned.sources[0]);
  assert.equal(exported.type, "agent-derived");
  assert.match(exported.text, /Private revised claim/);
  assert.ok(exported.caveats.includes("Not runtime-verified."));
  manager.appendCompaction("Only a brief summary remains", null, 0, {}, true);
  const restored = JSON.stringify(await runner.emitContext(manager.buildSessionProjection().messages));
  assert.deepEqual(errors, []);
  assert.match(restored, /Runtime behavior is not yet verified/);
  assert.match(restored, /Not runtime-verified/);
  assert.doesNotMatch(restored, /large original body/);
  assert.doesNotMatch(restored, /binding|payloadVersion|readStatus/);
  const control = async (operation) => {
    const result = await tools.get("runtime_guard").definition.execute("guard", { operation }, undefined, undefined, context);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  assert.deepEqual((await control({ action: "get" })).scopes, { global: 0, local: 0, session: 0 });
  assert.equal(fs.existsSync(path.join(getAgentDir(), "runtime-guards.sqlite")), false);
  const rule = { id: "host-check", tools: ["bash"], read: ["input.command"], effect: "block", check: 'e=>({verdict:e.input.command==="blocked"?"violation":"pass"})', hint: "Use an allowed command." };
  await control({ action: "put", scope: "global", expectedRevision: 0, rule });
  assert.equal(fs.existsSync(path.join(getAgentDir(), "runtime-guards.sqlite")), true);
  assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "blocked", input: { command: "blocked" } })).block, true);
  assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "allowed", input: { command: "allowed" } }), undefined);
  assert.deepEqual(errors, []);
  console.log("native factory, empty-policy read, owned VM and profile storage passed");
} finally { await runner.emit({ type: "session_shutdown" }); }
