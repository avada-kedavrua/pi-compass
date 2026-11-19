import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import extensionFactory from "../src/index.ts";
import { DAG_APPROVAL_OPTION } from "../src/dag-approval.mjs";
import { bindDagApprovalQuestionnaire, captureHumanDecision } from "../src/goal-run.mjs";
import { humanSourceRef, latestHumanSource } from "../src/goal-sources.mjs";
import { emptyContextState, planWatchBoundary, restoreContextState, searchContext } from "../src/context-core.mjs";
import { contextRef, contextSelection } from "../src/context-values.mjs";
import { SessionManager, appendDrafts, assertPaired, contextPreview, modelText, sourceVersion, user } from "./helpers/context-host.mjs";

const { ExtensionRunner } = await import(new URL("dist/core/extensions/runner.js", pathToFileURL(`${piRoot}/`)));
const { validateToolArguments } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/utils/validation.js", pathToFileURL(`${piRoot}/`)));
const { createCodemodeToolDefinition } = await import(new URL("dist/extensions/codemode/tool.js", pathToFileURL(`${piRoot}/`)));
let nextCall = 0;

// Real installed boundary chaining and session projection; tool registry/lifecycle
// actions are adapters. This is not a live AgentSession/provider acceptance test.
async function setup(laterHandler, earlierContextHandler, cwd = "/context-integration") {
  const manager = SessionManager.inMemory(cwd);
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
  if (earlierContextHandler) extensions.unshift({ path: "earlier-extension", handlers: new Map([["context", [earlierContextHandler]]]) });
  if (laterHandler) extensions.push({ path: "later-extension", handlers: new Map([["turn_end", [laterHandler]]]) });
  const runner = new ExtensionRunner(extensions, {}, cwd, manager, undefined);
  const errors = [];
  let aborted = false;
  runner.errorListeners.add((error) => errors.push(error));
  runner.abortFn = () => { aborted = true; };
  await runner.emit({ type: "session_start" });
  // Goal capture itself is unrelated to native provider execution; context is a fixed tool.
  await handlers.get("before_agent_start")[0]({ prompt: "Goal: preserve parent context while working locally." }, runner.createContext());
  await runner.emitContext(manager.buildSessionProjection().messages);
  user(manager, "PARENT ONLY");
  // Native protocol fixtures use entry IDs; actual public calls use only refs.
  function ref(id, version, binding) {
    const hit = searchContext(manager.getBranch(), { context: contextPreview(manager) }, restoreContextState(manager.getBranch()), { ids: [id], sourceScope: "all", limit: 16 }).hits.find((hit) => !binding || hit.binding === binding);
    assert.ok(hit, "fixture source is recoverable");
    return contextRef({ binding: binding ?? hit.binding, version: version ?? hit.version });
  }
  function intent(parameters) {
    const { expectedRevision, ids, version, versions, binding, scope, capture, exportIds, kind, verifiedAgainst, watchScope, content, ...input } = parameters;
    if (ids?.length) {
      const refs = ids.map((id) => ref(id, version ?? versions?.find((item) => item.id === id)?.version, binding));
      if (["load", "replace", "mark", "spill"].includes(input.action)) input.source = refs[0];
      else input.sources = refs;
    }
    if (capture) input.capture = capture.map((item) => (item.ref ? item : { ref: ref(item.id, item.version, item.binding), mode: item.mode }));
    if (exportIds) input.exportSources = exportIds.map((id) => ref(id));
    if (kind === "skill") input.skill = true;
    if (verifiedAgainst) input.verifiedAgainst = ref(verifiedAgainst.id, verifiedAgainst.version, verifiedAgainst.binding);
    if (watchScope) input.target = watchScope === "root" ? "root" : "parent";
    if (content !== undefined) input.text = content;
    return input;
  }
  async function turn(parameters, { apply = true } = {}) {
    const input = intent(parameters);
    const id = `integration-${++nextCall}`;
    const message = {
      role: "assistant", content: [{ type: "toolCall", id, name: "compass_context", arguments: input }],
      api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now(),
    };
    const messageEntryId = manager.appendMessage(message);
    let output;
    try {
      const tool = tools.get("compass_context");
      output = await tool.execute(id, validateToolArguments(tool, { name: tool.name, arguments: input }), undefined, undefined, runner.createContext());
    }
    catch (error) { output = { isError: true, content: [{ type: "text", text: String(error.message) }] }; }
    const result = { role: "toolResult", toolCallId: id, toolName: "compass_context", ...output, timestamp: Date.now() };
    const resultEntryId = manager.appendMessage(result);
    const proposal = await runner.emitBoundary({
      type: "turn_end", turnIndex: 0, outcome: "completed", message, toolResults: [result],
      messageEntryId, toolResultEntryIds: [resultEntryId],
    }, (drafts) => contextPreview(manager, drafts));
    assert.equal(proposal.valid, true);
    if (apply) {
      appendDrafts(manager, proposal.entries);
      await runner.emitContext(manager.buildSessionProjection().messages);
    }
    return proposal;
  }
  async function finish(outcome = "completed") {
    const message = { role: "assistant", content: [{ type: "text", text: "Done with this turn." }], api: "test", provider: "test", model: "test", usage: {}, stopReason: outcome === "aborted" ? "aborted" : "stop", timestamp: Date.now() };
    const messageEntryId = manager.appendMessage(message);
    const proposal = await runner.emitBoundary({ type: "turn_end", turnIndex: 0, outcome, message, toolResults: [], messageEntryId, toolResultEntryIds: [] }, (drafts) => contextPreview(manager, drafts));
    assert.equal(proposal.valid, true);
    appendDrafts(manager, proposal.entries);
    return proposal;
  }
  return { manager, runner, tools, turn, finish, ref, intent, errors, aborted: () => aborted };
}

test("installed runner chains frame entry and return; only committed metadata becomes active", async () => {
  const host = await setup();
  const { manager, tools, runner } = host;
  const statuses = [];
  async function readState(cursor) {
    const native = runner.createContext();
    const ctx = { cwd: native.cwd, sessionManager: native.sessionManager, hasUI: true, ui: { setStatus(key, text) { statuses.push({ key, text }); } } };
    return JSON.parse((await tools.get("compass_state").execute("frame-state", cursor ? { cursor } : {}, undefined, undefined, ctx)).content[0].text);
  }
  const rootState = await readState();
  assert.equal(rootState.goal, null, "frame use must not implicitly create a Goal");
  const proposal = await host.turn({ action: "call", expectedRevision: 0, task: "LOCAL PROCEDURE" }, { apply: false });
  assert.deepEqual(restoreContextState(manager.getBranch()), emptyContextState(), "returning drafts is not committing them");
  const beforeCommit = await tools.get("compass_context_search").execute("read-state", {}, undefined, undefined, runner.createContext());
  assert.equal(JSON.parse(beforeCommit.content[0].text).frame, "root");
  assert.equal((await readState(rootState.cursor)).unchanged, true, "queued entry is not a committed frame");
  appendDrafts(manager, proposal.entries);
  await runner.emitContext(manager.buildSessionProjection().messages);
  const entered = await readState(rootState.cursor);
  assert.equal(entered.frame, restoreContextState(manager.getBranch()).frames[0].id);
  assert.equal(entered.unchanged, undefined);
  assert.notEqual(entered.cursor, rootState.cursor, "native context revision participates in the cursor");
  assert.match(statuses.at(-1).text, /^frame 1 · /, "Human footer reflects the committed frame without polling");
  assert.match(modelText(manager), /LOCAL PROCEDURE/);
  assert.doesNotMatch(modelText(manager), /PARENT ONLY/);
  assertPaired(manager);
  const returned = await host.turn({ action: "return", expectedRevision: 1, result: "SELECTED RESULT" });
  assert.equal(returned.continue, true);
  const restored = await readState(entered.cursor);
  assert.equal(restored.frame, "root");
  assert.equal(statuses.at(-1).text, "frame: root");
  assert.match(modelText(manager), /PARENT ONLY/);
  assert.match(modelText(manager), /SELECTED RESULT/);
  assert.doesNotMatch(modelText(manager), /LOCAL PROCEDURE/);
  assertPaired(manager);
  assert.deepEqual(host.errors, []);
});

test("Agent data-only path enters a long frame and receives correlated terminal receipts", async () => {
  const host = await setup();
  for (let index = 0; index < 350; index++) user(host.manager, `old parent observation ${index}`);
  user(host.manager, "Font 微软雅黑; red text for unmet targets; green text for challenge success.");
  const tool = host.tools.get("compass_context");
  const search = JSON.parse((await host.tools.get("compass_context_search").execute("recover", { query: "微软雅黑 green unknownword" }, undefined, undefined, host.runner.createContext())).content[0].text);
  const source = search.hits.find((hit) => hit.text?.includes("Font 微软雅黑"));
  assert.ok(source);
  await host.turn({ action: "pin", sources: [source.ref], lifetime: "session" });
  await host.turn({ action: "call", task: "Investigate only the retained decision", capture: [{ ref: source.ref, mode: "ref" }] });
  const entered = restoreContextState(host.manager.getBranch());
  assert.equal(entered.frames.length, 1);
  assert.ok(entered.frames[0].saved.length > 256);
  const receipt = host.manager.getBranch().findLast((entry) => entry.customType === "pi-compass-v2.context-message");
  assert.equal(JSON.parse(receipt.content).resultStatus, "applied");
  assert.equal(receipt.details.revision, 2);
  assert.match(receipt.details.callId, /^integration-/);
  await assert.rejects(() => tool.execute("invalid-mark", { action: "mark", source: source.ref }, undefined, undefined, host.runner.createContext()), /Handling rationale|Mark requires/);
  assert.equal(restoreContextState(host.manager.getBranch()).revision, 2, "invalid mutation is rejected before returning queued");
  await host.turn({ action: "return", expectedRevision: 2, result: "evidence retained" });
  assert.equal(restoreContextState(host.manager.getBranch()).frames.length, 0);
  assert.match(modelText(host.manager), /old parent observation 349/);
  assertPaired(host.manager);
});

test("source refs and installed boundary carry verified content-range moves", async () => {
  const host = await setup();
  const id = host.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "header\nmove me\nkeep me" }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() });
  const version = sourceVersion(host.manager, id);
  const tool = host.tools.get("compass_context");
  assert.equal(tool.parameters.additionalProperties, false);
  const selected = await host.tools.get("compass_context_search").execute("find", { refs: [host.ref(id)], view: "details" }, undefined, undefined, host.runner.createContext());
  assert.match(JSON.parse(selected.content[0].text).hits[0].text, /move me/);
  await host.turn({ action: "move", expectedRevision: 0, ids: [id], version, range: { part: 0, startLine: 2, endLine: 2 } });
  await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  const projected = host.manager.buildSessionProjection().messages;
  const remainder = projected.find((message) => message.role === "assistant" && message.content?.some?.((part) => part.text?.includes("keep me")));
  assert.ok(remainder);
  assert.doesNotMatch(JSON.stringify(remainder), /move me/);
  assert.match(modelText(host.manager), /move me/);
  assert.match(JSON.stringify(host.manager.getEntry(id)), /move me/);
  assert.equal(restoreContextState(host.manager.getBranch()).revision, 1);
  assertPaired(host.manager);
  assert.deepEqual(host.errors, []);
});

test("verified repeat relocation crosses the native tool schema and keeps both read exchanges", async () => {
  const host = await setup();
  const payload = `one\n${"two ".repeat(8000)}\nthree`;
  const read = (callId) => {
    host.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "notes.txt" } }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
    return host.manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: payload }], isError: false, timestamp: Date.now() });
  };
  const first = read("first-read");
  const second = read("second-read");
  const prior = structuredClone(host.manager.getEntry(first));
  const compared = structuredClone(host.manager.getEntry(second));
  const beforeBytes = Buffer.byteLength(modelText(host.manager));
  const version = sourceVersion(host.manager, first);
  assert.ok(host.tools.get("compass_context").parameters.anyOf.flatMap((variant) => variant.anyOf ?? [variant]).some((variant) => variant.properties.verifiedAgainst));
  await host.turn({ action: "move", expectedRevision: 0, ids: [first], version, verifiedAgainst: { id: second, version } });
  assert.deepEqual(host.manager.getEntry(first), prior);
  assert.deepEqual(host.manager.getEntry(second), compared);
  assert.equal(modelText(host.manager).split(JSON.stringify(payload).slice(1, -1)).length - 1, 1, "verified relocation keeps one covered payload, not a new duplicate");
  assert.ok(Buffer.byteLength(modelText(host.manager)) < beforeBytes, "coalescing reduces serialized context for the representative large read");
  assert.match(modelText(host.manager), /Verified exact repeat/);
  assert.match(modelText(host.manager), /one/);
  const history = await host.tools.get("compass_context_search").execute("recover-covered", { sourceScope: "history", refs: [host.ref(second, version)], view: "handles" }, undefined, undefined, host.runner.createContext());
  assert.equal(contextSelection(JSON.parse(history.content[0].text).hits[0].ref).version, version);
  const pinned = read("pinned-read");
  await host.turn({ action: "pin", expectedRevision: 1, ids: [pinned] });
  await host.turn({ action: "move", expectedRevision: 2, ids: [first], version, verifiedAgainst: { id: pinned, version } });
  assert.equal(restoreContextState(host.manager.getBranch()).revision, 2, "coalescing cannot consume a pinned companion");
  assert.match(modelText(host.manager), /Pinned source.*explicitly unpinned/);
  assertPaired(host.manager);
  assert.deepEqual(host.errors, []);
});

test("native nested watch arm and cancellation own the frame before a top-level turn ends", async () => {
  const host = await setup();
  await host.turn({ action: "call", expectedRevision: 0, task: "wait within frame" });
  await host.runner.emit({ type: "tool_execution_end", toolName: "watch", toolCallId: "nested-arm", parentToolCallId: "code", isError: false, result: { content: [], details: { id: "nested-watch", instanceId: "native-arm", status: "armed", repeatMs: 1000 } } });
  let state = restoreContextState(host.manager.getBranch());
  assert.equal(state.watches["nested-watch"]?.owner, state.frames[0].id);
  assert.equal(state.watches["nested-watch"]?.instanceId, "native-arm");
  await host.turn({ action: "return", expectedRevision: state.revision });
  assert.equal(restoreContextState(host.manager.getBranch()).frames.length, 1, "an owned live nested watch blocks return");
  await host.runner.emit({ type: "tool_execution_end", toolName: "unwatch", toolCallId: "nested-cancel", parentToolCallId: "code", isError: false, result: { content: [], details: { cancelledInstanceIds: ["native-arm"] } } });
  state = restoreContextState(host.manager.getBranch());
  assert.deepEqual(state.watches, {});
  await host.turn({ action: "return", expectedRevision: state.revision });
  assert.equal(restoreContextState(host.manager.getBranch()).frames.length, 0);
  assertPaired(host.manager);
  assert.deepEqual(host.errors, []);
});

test("an unsupported GoalRun branch aborts request assembly rather than using stale state", async () => {
  const host = await setup();
  host.manager.appendCustomEntry("pi-compass-v2.goalrun", { schemaVersion: 6, goal: {}, plan: {} });
  await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.equal(host.aborted(), true);
  assert.ok(host.errors.some((error) => /Unsupported.*schema/.test(error.error)));
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

test("request-side pin overlay restores omitted text and image values after native compaction", async () => {
  const host = await setup();
  const imageValue = host.manager.appendCustomMessageEntry("test-value", [
    { type: "text", text: "Pinned evidence" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  ], false);
  await host.turn({ action: "pin", expectedRevision: 0, ids: [imageValue], kind: "memory", caveats: ["Retain the original evidence."] });
  const before = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.equal(before.filter((message) => message.customType === "pi-compass-v2.value").length, 0, "visible pins need no overlay");
  host.manager.appendCompaction("Native summary omitted the pinned evidence.", null, 0, {}, true);
  const after = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.deepEqual(host.errors, []);
  const overlays = after.filter((message) => message.customType === "pi-compass-v2.value");
  assert.equal(overlays.length, 1);
  assert.deepEqual(overlays[0].content.slice(-1), [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
  assert.match(JSON.stringify(overlays[0].content), /Retain the original evidence/);
  assert.deepEqual(host.errors, []);
});

test("request-side pin overlay is deduplicated when an equivalent retained view is already present", async () => {
  const host = await setup();
  const id = user(host.manager, "Pinned Human requirement");
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id], caveats: ["Keep this requirement."] });
  const first = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.equal(first.filter((message) => message.customType === "pi-compass-v2.value").length, 0);
  host.manager.appendCompaction("Summary", null, 0, {}, true);
  const second = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  const third = await host.runner.emitContext(second);
  assert.equal(second.filter((message) => message.customType === "pi-compass-v2.value").length, 1);
  assert.equal(third.filter((message) => message.customType === "pi-compass-v2.value").length, 1, "the same request overlay is not duplicated by composition");
});

test("pin retention checks the outgoing request, not just native projection membership", async () => {
  const host = await setup(undefined, (event) => ({ messages: event.messages.filter((message) => message.customType !== "test-pinned") }));
  const id = host.manager.appendCustomMessageEntry("test-pinned", "COMPLETE PIN BODY", false);
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id] });
  const messages = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.match(JSON.stringify(messages), /COMPLETE PIN BODY/);
  assert.deepEqual(host.errors, []);
});

test("a matching pin marker cannot hide altered content", async () => {
  const host = await setup();
  const id = user(host.manager, "IMMUTABLE PIN BODY");
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id] });
  host.manager.appendCompaction("Summary", null, 0, {}, true);
  const messages = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  const snapshot = messages.find((message) => message.customType === "pi-compass-v2.value");
  snapshot.content.at(-1).text = "altered body";
  await host.runner.emitContext(messages);
  assert.equal(host.aborted(), true);
  assert.ok(host.errors.some((error) => /altered|changed/.test(error.error)));
});

test("missing immutable source aborts pin restoration instead of sending unverifiable data", async () => {
  const host = await setup();
  const id = user(host.manager, "Pinned requirement");
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id] });
  const branch = host.manager.getBranch();
  host.manager.getBranch = () => branch.filter((entry) => entry.id !== id);
  await host.runner.emitContext([{ role: "user", content: "Continue", timestamp: Date.now() }]);
  assert.equal(host.aborted(), true);
  assert.ok(host.errors.some((error) => /source.*not on|unavailable/.test(error.error)));
});

test("an existing boundary materializes retained snapshots once without forcing a request", async () => {
  const host = await setup();
  const id = user(host.manager, "MATERIALIZED PIN");
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id] });
  host.manager.appendCompaction("Summary", null, 0, {}, true);
  const before = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.ok(before.some((message) => message.customType === "pi-compass-v2.value"));
  const proposal = await host.finish("aborted");
  assert.equal(proposal.continue, false);
  assert.match(modelText(host.manager), /MATERIALIZED PIN/);
  assert.equal(restoreContextState(host.manager.getBranch()).revision, 2);
  const stable = await host.finish();
  assert.equal(stable.entries.length, 0, "do not persist another copy on every turn");
  const version = restoreContextState(host.manager.getBranch()).values[`root/${id}`].version;
  await host.turn({ action: "unpin", expectedRevision: 2, ids: [id] });
  await host.turn({ action: "drop", expectedRevision: 3, ids: [id], versions: [{ id, version }] });
  assert.equal(restoreContextState(host.manager.getBranch()).revision, 3, "a custom snapshot must not bypass the original Human value's read-only policy");
  assert.match(modelText(host.manager), /MATERIALIZED PIN/);
  assertPaired(host.manager);
  assert.deepEqual(host.errors, []);
});

test("root pins recover through a compacted frame entry and scoped duplicates retire on return", async () => {
  const host = await setup();
  const id = user(host.manager, "ROOT SCOPED PIN");
  const revision = () => restoreContextState(host.manager.getBranch()).revision;
  await host.turn({ action: "pin", expectedRevision: revision(), ids: [id] });
  host.manager.appendCompaction("Parent summary", null, 0, {}, true);
  await host.turn({ action: "call", expectedRevision: revision(), task: "child" });
  await host.turn({ action: "pin", expectedRevision: revision(), ids: [id] });
  host.manager.appendCompaction("Child summary", null, 0, {}, true);
  const messages = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.equal(messages.filter((message) => message.customType === "pi-compass-v2.value").length, 1);
  await host.turn({ action: "return", expectedRevision: revision() });
  assert.match(modelText(host.manager), /ROOT SCOPED PIN/);
  assert.equal(restoreContextState(host.manager.getBranch()).pins.length, 1);
  assertPaired(host.manager);
  assert.deepEqual(host.errors, []);
});

test("a compacted pin can be retired without a forced load or resurrection", async () => {
  const host = await setup();
  const id = user(host.manager, "RETIRED PIN");
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id] });
  host.manager.appendCompaction("Summary", null, 0, {}, true);
  await host.turn({ action: "unpin", expectedRevision: 1, ids: [id] });
  const messages = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.doesNotMatch(JSON.stringify(messages), /RETIRED PIN/);
  assert.deepEqual(restoreContextState(host.manager.getBranch()).pins, []);
  assert.deepEqual(host.errors, []);
});

test("request snapshots cannot mutate immutable source image blocks", async () => {
  const host = await setup();
  const id = host.manager.appendCustomMessageEntry("test-value", [{ type: "image", mimeType: "image/png", data: "original" }], false);
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id] });
  const original = structuredClone(host.manager.getEntry(id));
  host.manager.appendCompaction("Summary", null, 0, {}, true);
  const messages = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  messages.find((message) => message.customType === "pi-compass-v2.value").content.at(-1).data = "mutated downstream";
  assert.deepEqual(host.manager.getEntry(id), original);
});

async function appendNativeRead(host, args, text, details) {
  const callId = `file-read-${++nextCall}`;
  const message = { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: args }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() };
  const messageEntryId = host.manager.appendMessage(message);
  const result = { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text }], details, isError: false, timestamp: Date.now() };
  const id = host.manager.appendMessage(result);
  const proposal = await host.runner.emitBoundary({
    type: "turn_end", turnIndex: 0, outcome: "completed", message, toolResults: [result],
    messageEntryId, toolResultEntryIds: [id],
  }, (drafts) => contextPreview(host.manager, drafts));
  assert.equal(proposal.valid, true);
  appendDrafts(host.manager, proposal.entries);
  return id;
}

test("planner and frame worker can produce, assess, consume, throw and replan with an exact artifact", async () => {
  const host = await setup();
  const { manager, runner, tools } = host;
  let n = 0;
  const call = async (name, input) => {
    const tool = tools.get(name);
    const output = await tool.execute(`flow-${++n}`, validateToolArguments(tool, { name, arguments: input }), undefined, undefined, runner.createContext());
    return JSON.parse(output.content[0].text);
  };
  const branchState = () => manager.getBranch().findLast((entry) => entry.customType === "pi-compass-v2.goalrun").data;
  const approve = async () => {
    const candidate = branchState();
    const { id, question, questionnaire } = candidate.plan.approvalRequest;
    const bound = bindDagApprovalQuestionnaire(candidate, { questions: [questionnaire] }, `question-${id}`, `call-${id}`);
    assert.equal(bound.bound, true);
    const { state } = captureHumanDecision(bound.state, {
      source: "ask_user_question", sourceEntryId: `question-${id}`, sourceCallId: `call-${id}`,
      details: { answers: [{ questionIndex: 0, question, kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION], preview: questionnaire.options[0].preview }] },
    });
    assert.ok(state.plan.approval);
    manager.appendCustomEntry("pi-compass-v2.goalrun", state);
    await runner.emit({ type: "session_start" });
  };
  const view = () => call("compass_state", { view: "plan" });
  const node = (id, title, extra = {}) => ({ id, title, acceptance: "Observable evidence", ...extra });
  await call("compass_goal", { action: "set", current: "Document an observed route", constraints: [], criteria: ["Route is documented"], sources: [humanSourceRef(manager.getBranch(), latestHumanSource(manager.getBranch()))] });
  await call("compass_plan", { action: "define", tasks: [node("a", "Produce observation"), node("b", "Consume observation", { fromTasks: ["a"] }), node("c", "Record output", { dependsOn: ["b"] })] });
  await approve();
  await host.turn({ action: "call", taskId: "a" });
  await host.turn({ action: "return", outcome: { status: "done", evidence: "Observation recorded without exporting the value" } });
  const missing = await call("compass_plan", { action: "assess", taskId: "a", status: "pass", evidence: "The recorded observation is correct" });
  assert.deepEqual(missing.ready, {});
  assert.equal(missing.waiting[0].taskId, "b");
  assert.match(missing.waiting[0].reason, /Artifact input from a is missing/);
  await assert.rejects(() => call("compass_context", { action: "call", taskId: "b" }), /Artifact input from a is missing.*No state changed/);
  await call("compass_plan", { action: "reopen", tasks: [{ id: "a", reason: "Export the observation for its declared consumer" }] });
  const claim = await host.turn({ action: "call", taskId: "a" }, { apply: false });
  assert.equal((await view()).tasks[0].status, "pending", "a queued frame does not claim the node");
  appendDrafts(manager, claim.entries);
  await runner.emitContext(manager.buildSessionProjection().messages);
  assert.equal((await view()).tasks[0].status, "in_progress");
  await host.turn({ action: "remember", text: "ROUTE_OBSERVATION", caveats: ["Local evidence only."], lifetime: "session" });
  const list = await call("compass_state", { view: "retained" });
  const memory = list.retained.find((hit) => hit.text === "ROUTE_OBSERVATION");
  assert.ok(memory);
  const returned = await host.turn({ action: "return", outcome: { status: "done", evidence: "Observed route from local fixture" }, exportSources: [memory.ref] }, { apply: false });
  assert.equal((await view()).tasks[0].status, "in_progress", "queued return does not settle the node");
  appendDrafts(manager, returned.entries);
  await runner.emitContext(manager.buildSessionProjection().messages);
  const produced = (await view()).tasks[0];
  assert.equal(produced.status, "done");
  assert.equal(produced.artifacts.length, 1);
  assert.deepEqual((await view()).ready, {}, "a returned artifact is not a semantic pass");
  await call("compass_plan", { action: "assess", taskId: "a", status: "pass", evidence: "Compared the route against the approved definition", caveats: ["No provider check."] });
  await host.turn({ action: "call", taskId: "b" });
  assert.equal((await view()).tasks[1].status, "in_progress");
  assert.match(modelText(manager), /ROUTE_OBSERVATION/);
  assert.match(modelText(manager), /Local evidence only/);
  assert.match(modelText(manager), /No provider check/);
  await host.turn({ action: "return", outcome: { status: "throw", reason: "Consumer scope was wrong", evidence: "Local route metadata contradicts the approved target", sideEffects: "None observed" } });
  const stopped = await view();
  assert.equal(stopped.stopped.taskId, "b");
  assert.equal(stopped.tasks[2].status, "pending");
  assert.equal(stopped.ready, undefined);
  await call("compass_plan", { action: "patch", upsertTasks: [{ id: "b", title: "Use the corrected local consumer", fromTasks: [], inputRefs: produced.artifacts }] });
  await approve();
  await host.turn({ action: "call", taskId: "b" });
  assert.equal((await view()).tasks[1].status, "in_progress");
  assert.match(modelText(manager), /ROUTE_OBSERVATION/);
  await host.turn({ action: "return", outcome: { status: "done", evidence: "Correct consumer used the original artifact" } });
  assert.equal((await view()).tasks[1].status, "done");
  assertPaired(manager);
  assert.deepEqual(host.errors, []);
});

test("append keeps an exact repeated read at the tail without rewriting raw history", async () => {
  const host = await setup();
  const payload = "READ_PAYLOAD_SAME\nsecond line\n";
  const first = await appendNativeRead(host, { path: "src/routes.mjs" }, payload);
  const raw = structuredClone(host.manager.getEntry(first));
  await appendNativeRead(host, { path: "src/routes.mjs" }, payload);
  assert.equal(modelText(host.manager).match(/READ_PAYLOAD_SAME/g)?.length, 1);
  assert.match(modelText(host.manager), /Identical native read payload is retained/);
  await appendNativeRead(host, { path: "src/other.mjs" }, payload);
  assert.equal(modelText(host.manager).match(/READ_PAYLOAD_SAME/g)?.length, 2, "equal bytes from another source are not coalesced");
  assert.deepEqual(host.manager.getEntry(first), raw);
  assertPaired(host.manager);
  assert.deepEqual(host.errors, []);
});

test("only a complete canonical Skill read is automatically pinned in its frame", async () => {
  const host = await setup();
  await host.turn({ action: "call", task: "Read the local Skill" });
  const frame = restoreContextState(host.manager.getBranch()).frames.at(-1).id;
  await appendNativeRead(host, { path: "skills/custom/SKILL.md", limit: 2 }, "PARTIAL");
  const full = await appendNativeRead(host, { path: "skills/custom/SKILL.md" }, "COMPLETE_RULES");
  const pins = restoreContextState(host.manager.getBranch()).pins;
  assert.deepEqual(pins.map(({ id, scope }) => ({ id, scope })), [{ id: full, scope: frame }]);
  await host.turn({ action: "return" });
  assert.deepEqual(restoreContextState(host.manager.getBranch()).pins, []);
  assert.deepEqual(host.errors, []);
});

test("explicit active Skill retention survives native compaction and frames, then retires", async () => {
  const host = await setup();
  const source = { role: "assistant", content: [{ type: "toolCall", id: "read-skill", name: "read", arguments: { path: "SKILL.md" } }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() };
  host.manager.appendMessage(source);
  const id = host.manager.appendMessage({ role: "toolResult", toolCallId: "read-skill", toolName: "read", content: [{ type: "text", text: "FULL_SKILL_RULE_MUST_SURVIVE" }], isError: false, timestamp: Date.now() });
  const original = structuredClone(host.manager.getEntry(id));
  await host.turn({ action: "pin", expectedRevision: 0, ids: [id], kind: "skill", scope: "root" });
  host.manager.appendCompaction("lossy summary", host.manager.getLeafId(), 100);
  await host.turn({ action: "call", expectedRevision: 1, task: "apply the active Skill without copying parent process" });
  assert.match(modelText(host.manager), /FULL_SKILL_RULE_MUST_SURVIVE/);
  let control = restoreContextState(host.manager.getBranch());
  await host.turn({ action: "return", expectedRevision: control.revision });
  control = restoreContextState(host.manager.getBranch());
  await host.turn({ action: "mark", expectedRevision: control.revision, ids: [id], version: sourceVersion(host.manager, id), handling: "retired", reason: "Skill no longer applies to the completed local work." });
  host.manager.appendCompaction("after retirement", host.manager.getLeafId(), 100);
  const outgoing = await host.runner.emitContext(host.manager.buildSessionProjection().messages);
  assert.doesNotMatch(JSON.stringify(outgoing), /FULL_SKILL_RULE_MUST_SURVIVE/);
  assert.deepEqual(host.manager.getEntry(id), original);
  assertPaired(host.manager);
  assert.deepEqual(host.errors, []);
});

test("structured Human answers survive a frame without previews or lost handling notes", async () => {
  const host = await setup();
  await host.turn({ action: "call", expectedRevision: 0, task: "clarify inside a frame" });
  const question = { role: "assistant", content: [{ type: "toolCall", id: "human-question", name: "ask_user_question", arguments: { questions: [{ question: "Select storage?", header: "Storage", options: [{ label: "Postgres", description: "SQL storage", preview: "RICH_PREVIEW_SHOULD_NOT_REPEAT" }, { label: "SQLite", description: "Local storage" }] }, { question: "Select region?", header: "Region", options: [{ label: "EU", description: "European region" }, { label: "US", description: "US region" }] }] } }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() };
  const source = host.manager.appendMessage(question);
  const details = { schemaVersion: 1, outcome: "partial", answers: [{ questionIndex: 0, question: "Select storage?", kind: "option", answer: "Postgres", notes: `${"qualified ".repeat(100)}END ANSWER NOTE`, selected: ["Postgres"], preview: "RICH_PREVIEW_SHOULD_NOT_REPEAT" }], unanswered: [1], globalNote: `${"EU only ".repeat(100)}END GLOBAL NOTE` };
  const result = { role: "toolResult", toolCallId: "human-question", toolName: "ask_user_question", content: [{ type: "text", text: "Rendered summary omits material notes." }], details, isError: false, timestamp: Date.now() };
  const id = host.manager.appendMessage(result);
  const proposal = await host.runner.emitBoundary({ type: "turn_end", turnIndex: 0, outcome: "completed", message: question, toolResults: [result], messageEntryId: source, toolResultEntryIds: [id] }, (drafts) => contextPreview(host.manager, drafts));
  assert.equal(proposal.valid, true);
  appendDrafts(host.manager, proposal.entries);
  await host.turn({ action: "return", expectedRevision: 2 });
  const text = modelText(host.manager);
  assert.match(text, /END ANSWER NOTE/);
  assert.match(text, /END GLOBAL NOTE/);
  assert.match(text, /partial/);
  assert.doesNotMatch(text, /RICH_PREVIEW_SHOULD_NOT_REPEAT/);
  assertPaired(host.manager);
  let control = restoreContextState(host.manager.getBranch());
  assert.equal(control.values[`root/${id}`].handling, "active");
  await host.turn({ action: "mark", expectedRevision: control.revision, ids: [id], version: sourceVersion(host.manager, id), handling: "handled", reason: "Storage choice recorded; region is still unresolved." });
  control = restoreContextState(host.manager.getBranch());
  assert.equal(control.values[`root/${id}`].handling, "handled");
  assert.match(modelText(host.manager), /region is still unresolved/);
  const raw = host.manager.getEntry(id);
  assert.deepEqual(raw.message.details, details);
  assert.deepEqual(host.errors, []);
});

test("spill verifies a project artifact before removing context and load rechecks the exact receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compass-spill-"));
  try {
    const host = await setup(undefined, undefined, root);
    const id = host.manager.appendCustomMessageEntry("test-value", "ARTIFACT PAYLOAD", false);
    const original = structuredClone(host.manager.getEntry(id));
    await host.turn({ action: "spill", expectedRevision: 0, ids: [id], version: sourceVersion(host.manager, id), path: "evidence.json", purpose: "retain the selected evidence" });
    assert.doesNotMatch(modelText(host.manager), /ARTIFACT PAYLOAD/);
    assert.equal(JSON.parse(await readFile(path.join(root, "evidence.json"), "utf8")).content, "ARTIFACT PAYLOAD");
    await host.turn({ action: "load", expectedRevision: 1, ids: [id], version: sourceVersion(host.manager, id) });
    assert.match(modelText(host.manager), /ARTIFACT PAYLOAD/);
    assert.deepEqual(host.manager.getEntry(id), original);
    assertPaired(host.manager);
    const before = restoreContextState(host.manager.getBranch());
    await writeFile(path.join(root, "evidence.json"), "tampered");
    await assert.rejects(host.tools.get("compass_context").execute("failed-load", { action: "load", source: host.ref(id) }, undefined, undefined, host.runner.createContext()), /digest|byte length/);
    assert.deepEqual(restoreContextState(host.manager.getBranch()), before);
    assert.deepEqual(host.errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native Code Mode-only loadout keeps model-only context mutations declared and search callable", async () => {
  const host = await setup();
  const mutation = host.tools.get("compass_context");
  const search = host.tools.get("compass_context_search");
  assert.equal(mutation.exposure, "model-only");
  assert.notEqual(search.exposure, "model-only");
  const tools = [mutation, search];
  const result = createCodemodeToolDefinition({ getMode: () => "only" }).prepareLoadout({
    declared: tools, callable: [search],
    getExposure: (name) => host.tools.get(name).exposure ?? "direct",
    getNamespace: () => undefined,
    getPromptGuidelines: (name) => host.tools.get(name).promptGuidelines ?? [],
  });
  assert.ok(result.hiddenDeclarations.includes(search.name));
  assert.ok(!result.hiddenDeclarations.includes(mutation.name), "context mutations stay directly reachable in Code Mode-only mode");
  assert.match(result.descriptions.codemode, /compass_context_search/);
  assert.doesNotMatch(result.descriptions.codemode, /compass_context\(/);
});
