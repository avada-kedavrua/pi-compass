import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import { RuntimeGuards, registerRuntimeGuards } from "../src/runtime-guard.mjs";
import { GuardVM } from "../src/runtime-guard-vm.mjs";
import { GUARD_NOTICE_TYPE, GUARD_STATE_TYPE, normalizeGuardRule, projectGuardEvent, guardToolSchema } from "../src/runtime-guard-core.mjs";
import { SessionManager, appendDrafts, assertPaired, contextPreview, modelText } from "./helpers/context-host.mjs";
const { ExtensionRunner } = await import(new URL("dist/core/extensions/runner.js", pathToFileURL(`${piRoot}/`)));
const { validateToolArguments } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/utils/validation.js", pathToFileURL(`${piRoot}/`)));

const rule = (effect = "block") => ({ id: "exact-cd", tools: ["bash"], read: ["input.command"], effect, hint: "Use relative paths.", check: 'e=>({verdict:e.input.command==="cd x"?"violation":"pass"})' });
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-guards-"));
  const manager = SessionManager.inMemory(dir);
  const handlers = new Map();
  const tools = new Map();
  const api = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [{ name: "bash" }, ...tools.values()]; },
    appendEntry(type, data) { manager.appendCustomEntry(type, structuredClone(data)); },
  };
  const guards = registerRuntimeGuards(api, { profileDir: path.join(dir, "profile"), ...options });
  const runner = new ExtensionRunner([{ path: "runtime-guards", handlers }], {}, dir, manager, undefined);
  const ctx = runner.createContext();
  guards.restore(ctx);
  t.after(async () => { await guards.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const control = (operation) => guards.control(operation, ctx);
  const call = (command, ids = {}) => runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "call", input: { command }, ...ids });
  return { dir, manager, handlers, tools, api, guards, runner, ctx, control, call };
}

test("native session guard CRUD: immediate block, idempotence, cases, stale revisions and branch restore", async (t) => {
  const h = fixture(t);
  const first = await h.control({ action: "put", expectedRevision: 0, rule: rule() });
  assert.deepEqual(first, { resultStatus: "applied", scope: "session", id: "exact-cd", revision: 1 }, "mutation gives the next CAS revision, not a listing cursor or rule body");
  assert.equal((await h.call("cd x")).block, true);
  assert.equal(await h.call("printf 'cd x'"), undefined, "a rule's exact semantic coverage remains Agent-owned");
  assert.equal((await h.control({ action: "put", expectedRevision: 1, rule: rule() })).resultStatus, "unchanged");
  await assert.rejects(h.control({ action: "remove", id: "exact-cd", expectedRevision: 0 }), /Stale/);
  await assert.rejects(h.control({ action: "put", expectedRevision: 1, rule: { ...rule(), cases: [{ event: { toolName: "bash", input: { command: "cd x" } }, expected: "pass" }] } }), /cases failed/);
  assert.equal((await h.control({ action: "get" })).scopes.session, 1);
  const detail = await h.control({ action: "get", id: "exact-cd" });
  assert.deepEqual(detail, { scope: "session", revision: 1, rule: rule() });
  const verified = await h.control({ action: "test", id: "exact-cd", cases: [
    { event: { toolName: "bash", input: { command: "cd x" } }, expected: "violation" },
    { event: { toolName: "bash", input: { command: "pwd" } }, expected: "violation" },
  ] });
  assert.deepEqual(verified, { cases: [{ verdict: "violation" }, { verdict: "pass", expected: "violation" }] });
  const list = await h.control({ action: "get" });
  assert.equal(list.coverage, undefined);
  h.guards.restore(h.ctx);
  assert.deepEqual(await h.control({ action: "get", cursor: list.cursor }), { unchanged: true, cursor: list.cursor });
  await assert.rejects(h.control({ action: "get", id: "exact-cd", cursor: list.cursor }), /cursor only for a guard listing/);
  const parent = h.manager.getLeafId();
  await h.control({ action: "remove", id: "exact-cd", expectedRevision: 1 });
  assert.equal(await h.call("cd x"), undefined);
  h.manager.branch(parent);
  await h.runner.emit({ type: "session_tree" });
  assert.equal((await h.call("cd x")).block, true, "native branch restores its rule, not the other branch's deletion");
  assert.equal(h.manager.getBranch().filter((entry) => entry.customType === GUARD_STATE_TYPE).length, 1);
  h.manager.resetLeaf();
  await h.runner.emit({ type: "session_tree" });
  await h.control({ action: "put", expectedRevision: 0, rule: { ...rule(), hint: "Branch-specific hint." } });
  assert.notEqual((await h.control({ action: "get", cursor: list.cursor })).cursor, list.cursor, "the same revision on another branch need not mean the same rule");
});

test("global and local definitions share CAS persistence without local override or cross-project leakage", async (t) => {
  const h = fixture(t);
  await h.control({ action: "put", scope: "global", expectedRevision: 0, rule: rule() });
  await h.control({ action: "put", scope: "local", expectedRevision: 0, rule: { ...rule("warn"), check: 'e=>({verdict:"pass"})' } });
  assert.equal((await h.call("cd x")).block, true, "a local pass does not override global block");
  const localView = await h.control({ action: "get", scope: "local" });
  const globalView = await h.control({ action: "get", scope: "global", cursor: localView.cursor });
  assert.notEqual(globalView.unchanged, true, "a different projection needs its own cursor");
  assert.deepEqual(globalView.scopes, { global: 1 });
  assert.equal(globalView.rules[0].scope, "global");
  const other = new RuntimeGuards(h.api, { profileDir: path.join(h.dir, "profile") });
  other.restore(h.ctx);
  t.after(() => other.close());
  const sibling = { cwd: path.join(h.dir, "other-project"), sessionManager: h.ctx.sessionManager };
  const initial = await other.control({ action: "get" }, sibling);
  assert.deepEqual(initial.scopes, { global: 1, local: 0, session: 0 });
  await h.control({ action: "remove", scope: "global", id: "exact-cd", expectedRevision: 1 });
  assert.deepEqual(await h.control({ action: "get", scope: "local", cursor: localView.cursor }), { unchanged: true, cursor: localView.cursor }, "irrelevant scope changes do not invalidate the cursor");
  assert.equal(await other.check({ toolName: "bash", toolCallId: "other", input: { command: "cd x" } }, sibling), undefined);
  assert.equal((await other.control({ action: "get" }, sibling)).scopes.global, 2);
});

test("native boundary notice reaches parent for nested warn without changing JSON, structured content, images or continuation", async (t) => {
  const h = fixture(t);
  await h.control({ action: "put", expectedRevision: 0, rule: rule("warn") });
  const message = { role: "assistant", content: [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "nested result discarded" } }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() };
  const messageEntryId = h.manager.appendMessage(message);
  assert.equal(await h.call("cd x", { toolCallId: "outer/1", parentToolCallId: "outer" }), undefined);
  assert.equal(await h.call("cd x", { toolCallId: "outer/2", parentToolCallId: "outer" }), undefined);
  await h.control({ action: "put", expectedRevision: 1, rule: rule("block") });
  assert.equal((await h.call("cd x", { toolCallId: "outer/3", parentToolCallId: "outer" })).block, true);
  const result = { role: "toolResult", toolName: "codemode", toolCallId: "outer", content: [{ type: "text", text: '{"ok":true}' }, { type: "image", data: "AA==", mimeType: "image/png" }], structuredContent: { ok: true }, details: { native: true }, usage: { input: 1 }, isError: false, timestamp: Date.now() };
  const nativeEvent = { type: "tool_result", ...result, input: {} };
  const before = structuredClone(nativeEvent);
  assert.equal(await h.runner.emitToolResult(nativeEvent), undefined);
  assert.deepEqual(nativeEvent, before, "the guard leaves every native result field untouched");
  const resultId = h.manager.appendMessage(result);
  const boundary = await h.runner.emitBoundary({ type: "turn_end", turnIndex: 0, outcome: "completed", entries: [], continue: false, message, toolResults: [result], messageEntryId, toolResultEntryIds: [resultId] }, (drafts) => contextPreview(h.manager, drafts));
  assert.equal(boundary.valid, true);
  assert.equal(boundary.continue, false, "a warning never forces a provider turn");
  const notice = boundary.entries.find((entry) => entry.customType === GUARD_NOTICE_TYPE);
  assert.equal(notice.content, "Runtime guard\n- Warned bash (session/exact-cd, 2 calls): Use relative paths.\n- Blocked bash (session/exact-cd): Use relative paths.");
  appendDrafts(h.manager, boundary.entries);
  assert.match(modelText(h.manager), /runtime-guard.notice/);
  assertPaired(h.manager);
});

test("native handler composition documents the approved observation boundary, not final post-plugin inputs", async (t) => {
  const h = fixture(t);
  await h.control({ action: "put", expectedRevision: 0, rule: rule() });
  const later = new Map([["tool_call", [(event) => { event.input.command = "cd x"; }]]]);
  const runner = new ExtensionRunner([{ path: "guards", handlers: h.handlers }, { path: "later-mutator", handlers: later }], {}, h.dir, h.manager, undefined);
  const event = { type: "tool_call", toolName: "bash", toolCallId: "observed", input: { command: "pwd" } };
  assert.equal(await runner.emitToolCall(event), undefined);
  assert.equal(event.input.command, "cd x", "this platform limitation must remain explicit rather than falsely tested as prevented");
});

test("VM isolates every check, rejects capabilities/output/bad verdicts, and kills a stuck worker before recovery", async (t) => {
  const vm = new GuardVM();
  t.after(() => vm.close());
  const checks = [
    'e=>{globalThis.leak=1;return {verdict:"pass"}}',
    'e=>({verdict:typeof leak==="undefined"&&typeof process==="undefined"&&typeof fetch==="undefined"?"pass":"violation"})',
    'e=>({verdict:"not-a-verdict"})',
    'e=>{text("unwanted output");return {verdict:"pass"}}',
    'e=>{store("x",1);return {verdict:"pass"}}',
  ];
  const results = await vm.evaluate(checks.map((source) => ({ source, event: {} })));
  assert.deepEqual(results.map((item) => item.verdict), ["pass", "pass", "unknown", "unknown", "unknown"]);
  await assert.rejects(vm.evaluate([{ source: 'e=>("a".repeat(32)+"!").match(/^(a+)+$/)', event: {} }], { timeoutMs: 60 }), /deadline/);
  assert.equal((await vm.evaluate([{ source: 'e=>({verdict:"pass"})', event: {} }]))[0].verdict, "pass");
});

test("checks admitted while an idle worker terminates are pumped after its actual exit", async (t) => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  let began;
  let fail;
  const starting = new Promise((resolve, reject) => { began = resolve; fail = reject; });
  const deadline = setTimeout(() => fail(new Error("Idle retirement did not start")), 1000);
  const vm = new GuardVM({ idleMs: 1, createWorker(...args) {
    const worker = new Worker(...args);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = async () => { began(); await deferred; return terminate(); };
    return worker;
  } });
  t.after(async () => { clearTimeout(deadline); release(); await vm.close(); });
  const checks = [{ source: 'e=>({verdict:"pass"})', event: {} }];
  await vm.evaluate(checks);
  await starting;
  clearTimeout(deadline);
  const queued = vm.evaluate(checks);
  release();
  assert.equal((await queued)[0].verdict, "pass");
});

test("controller cancellation cannot activate a rule; concurrent initialization shares one private store", async (t) => {
  const abort = new AbortController();
  let seen;
  const h = fixture(t, { vm: { async evaluate(checks, options) { seen = options.signal; abort.abort(); return checks.map(() => ({ verdict: "pass" })); }, async close() {} } });
  const result = await h.tools.get("runtime_guard").execute("cancelled-registration", { operation: { action: "put", expectedRevision: 0, rule: rule() } }, abort.signal, undefined, h.ctx);
  assert.equal(result.isError, true, "tool-specific cancellation must prevent activation even after a verdict resolves");
  assert.equal(seen, abort.signal);
  assert.equal((await h.control({ action: "get" })).scopes.session, 0);
  const runtime = new RuntimeGuards(h.api, { profileDir: async () => { await Promise.resolve(); return path.join(h.dir, "other-profile"); } });
  t.after(() => runtime.close());
  const [first, second] = await Promise.all([runtime.store(), runtime.store()]);
  assert.equal(first, second);
  assert.equal(fs.existsSync(first.path), false, "initialization itself never creates persistent data");
});

test("queued controls cannot activate on a different native branch", async (t) => {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  const h = fixture(t, { vm: { async evaluate(checks) {
    if (first) { first = false; enter(); await held; }
    return checks.map(() => ({ verdict: "pass" }));
  }, async close() {} } });
  h.manager.appendCustomEntry("fixture.branch", { name: "A" });
  const running = h.control({ action: "put", expectedRevision: 0, rule: rule() });
  await entered;
  const queued = h.control({ action: "put", expectedRevision: 0, rule: { ...rule(), id: "queued" } });
  const settled = Promise.allSettled([running, queued]);
  h.manager.resetLeaf();
  h.manager.appendCustomEntry("fixture.branch", { name: "B" });
  h.guards.restore(h.ctx);
  release();
  assert.deepEqual((await settled).map((item) => item.status), ["rejected", "rejected"]);
  assert.equal((await h.control({ action: "get" })).scopes.session, 0);
});

test("a late nested check cannot add its notice to a different native branch", async (t) => {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let pause = false;
  const h = fixture(t, { vm: { async evaluate(checks) {
    if (pause) { enter(); await held; }
    return checks.map(() => ({ verdict: "pass" }));
  }, async close() {} } });
  await h.control({ action: "put", expectedRevision: 0, rule: rule() });
  pause = true;
  const checking = h.call("pwd", { toolCallId: "old/1", parentToolCallId: "old" });
  await entered;
  h.manager.resetLeaf();
  h.manager.appendCustomEntry("fixture.branch", { name: "new" });
  h.guards.restore(h.ctx);
  release();
  assert.equal((await checking).block, true);
  assert.equal(h.guards.flush({ entries: [] }), undefined, "old-branch failure must not contaminate new-branch context");
});

test("a check awaiting profile initialization cannot admit against another branch's empty policy", async (t) => {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const h = fixture(t, { profileDir: async () => { enter(); await held; return path.join(h.dir, "profile"); } });
  const checking = h.call("pwd", { toolCallId: "old/1", parentToolCallId: "old" });
  const reading = Promise.allSettled([h.control({ action: "get" })]);
  await entered;
  h.manager.resetLeaf();
  h.manager.appendCustomEntry("fixture.branch", { name: "new" });
  h.guards.restore(h.ctx);
  release();
  assert.equal((await reading)[0].status, "rejected", "a pending control read cannot return another branch's state");
  assert.equal((await checking)?.block, true, "even an empty policy cannot authorize a stale-branch call");
  assert.equal(h.guards.flush({ entries: [] }), undefined);
});

test("every nested runtime block remains visible if Code Mode discards the error", async (t) => {
  const broken = fixture(t);
  const profile = path.join(broken.dir, "profile");
  fs.mkdirSync(profile);
  const db = new DatabaseSync(path.join(profile, "runtime-guards.sqlite"));
  db.exec("PRAGMA user_version=9");
  db.close();
  assert.equal((await broken.call("pwd", { toolCallId: "outer/1", parentToolCallId: "outer" })).block, true);
  assert.match(broken.guards.flush({ entries: [] }).entries[0].content, /Blocked \(check unavailable\) bash: Guard runtime unavailable/);

  let race = false;
  let h;
  h = fixture(t, { vm: { async evaluate(checks) {
    if (race) { race = false; await h.control({ action: "remove", id: "exact-cd", expectedRevision: 1 }); }
    return checks.map(() => ({ verdict: "pass" }));
  }, async close() {} } });
  await h.control({ action: "put", expectedRevision: 0, rule: rule() });
  race = true;
  assert.equal((await h.call("pwd", { toolCallId: "race/1", parentToolCallId: "race" })).block, true);
  assert.match(h.guards.flush({ entries: [] }).entries[0].content, /scope changed/i);
});

test("schema and projection reject unbounded/unsafe input without mutation; broken block rules remain repairable", async (t) => {
  const h = fixture(t);
  const tool = { name: "runtime_guard", parameters: guardToolSchema() };
  const validate = (args) => validateToolArguments(tool, { name: tool.name, arguments: args });
  assert.throws(() => validate({ operation: { action: "put", expectedRevision: 0, rule: { ...rule(), extra: true } } }));
  assert.throws(() => normalizeGuardRule({ ...rule(), read: ["input.__proto__"] }), /Unsafe/);
  assert.throws(() => projectGuardEvent(rule(), { toolName: "bash", input: { command: "x".repeat(65536) } }, h.dir), /64 KiB/);
  const original = Object.getOwnPropertyDescriptor(Object.prototype.toString, "command");
  try {
    const projected = projectGuardEvent(normalizeGuardRule({ ...rule(), read: ["input.toString.command"] }), { toolName: "bash", input: { toString: { command: "deny" } } }, h.dir);
    assert.deepEqual(projected.input, { toString: { command: "deny" } });
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype.toString, "command"), original);
  } finally {
    if (original) Object.defineProperty(Object.prototype.toString, "command", original);
    else delete Object.prototype.toString.command;
  }
  let accessed = false;
  const input = Object.defineProperty({}, "command", { get() { accessed = true; return "pwd"; } });
  assert.throws(() => projectGuardEvent(rule(), { toolName: "bash", input }, h.dir), /accessors/);
  assert.equal(accessed, false, "projection must not execute host accessors");
  await h.control({ action: "put", expectedRevision: 0, rule: { ...rule(), check: 'e=>{throw Error("broken check")}' } });
  assert.match((await h.call("pwd")).reason, /could not check/);
  assert.equal(await h.guards.check({ toolName: "runtime_guard", input: {} }, h.ctx), undefined, "self-repair is not locked out");
  await h.control({ action: "remove", expectedRevision: 1, id: "exact-cd" });
  assert.equal(await h.call("pwd"), undefined);
  await h.control({ action: "put", expectedRevision: 2, rule: { ...rule(), read: [], check: 'e=>({verdict:e.parentToolCallId?"violation":"pass"})', cases: [
    { event: { toolName: "bash", input: {}, parentToolCallId: null }, expected: "pass" },
    { event: { toolName: "bash", input: {}, toolCallId: "outer/1", parentToolCallId: "outer" }, expected: "violation" },
  ] } });
  assert.equal((await h.call("pwd", { toolCallId: "outer/1", parentToolCallId: "outer" })).block, true);
});
