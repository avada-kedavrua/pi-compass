import test from "node:test";
import assert from "node:assert/strict";
import extensionFactory from "../src/index.ts";
import { FALLBACK_MODEL } from "../src/execution-orchestrator.mjs";
import { exactAnswers } from "./helpers/goal-state.mjs";
import { dagApprovalStatus, normalizeGoalRunState } from "../src/goal-run.mjs";
import { humanSourceRef } from "../src/goal-sources.mjs";

// Native extension surface: fixed seven tools, code-owned preconditions,
// interactive-only proposal expansion and structured-delegation consumption.
// These are installed-host adapters, not live AgentSession/provider acceptance.

function launchProjection({ agent, context }, tools = ["read"]) {
  return { ok: true, contract: { agent: { name: agent }, context, intercomBridge: { active: false },
    tools: { explicitAllowlist: true, effectiveAllowlist: tools, effectiveMcpTools: [], fanoutAuthorized: false } } };
}

function fakePi(options = {}) {
  const bus = new Map();
  const hooks = new Map();
  const tools = new Map();
  const entries = options.entries ?? [];
  const delegation = [];
  const notices = [];
  let active = [...(options.active ?? ["read", "bash", "edit", "write", "amend", "codemode", "subagent", "ask_user_question"])];
  const emit = (name, payload) => {
    for (const handler of [...(bus.get(name) ?? [])]) handler(payload);
    return true;
  };
  const subscribe = (name, handler) => {
    const listeners = bus.get(name) ?? new Set();
    listeners.add(handler);
    bus.set(name, listeners);
    return () => listeners.delete(handler);
  };
  if (options.bus !== false) subscribe("prompt-template:subagent:request", (request) => {
    if (!String(request.task ?? "").trim()) {
      queueMicrotask(() => emit("prompt-template:subagent:response", { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "invalid_request", error: "task must be non-empty" }));
      return;
    }
    delegation.push(structuredClone(request));
    // Model a bridge that accepts the request and then faults before acknowledging
    // it: the caller must fail closed without losing the correlation.
    if (options.faultDispatch === true || options.faultDispatch?.(request)) throw new Error("delegation bridge faulted after accepting the request");
    queueMicrotask(() => {
      emit("prompt-template:subagent:started", { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId });
      const response = options.respondDelegation
        ? options.respondDelegation(request)
        : { status: "completed", runId: `run-${request.nodeId}`, model: request.model, result: { kind: "structured", value: { status: "done", summary: `Inspected ${request.nodeId}.`, evidence: [`src/${request.nodeId}.ts:1`], reason: "" } }, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 2, durationMs: 100 } };
      Promise.resolve(response).then((value) => value && emit("prompt-template:subagent:response", { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...value }));
    });
  });
  const pi = {
    hooks, tools, entries, delegation, notices,
    sendMessage(message, options) {
      notices.push({ message, options, stopped: stateOf(pi).plan.stopped });
    },
    events: { on: subscribe, emit },
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(definition) {
      tools.set(definition.name, definition);
      if (definition.exposure === undefined || definition.exposure === "direct" || definition.exposure === "model-only") {
        if (!active.includes(definition.name)) active.push(definition.name);
      }
    },
    registerCommand(name, definition) { pi.commands ??= new Map(); pi.commands.set(name, definition); },
    getActiveTools() { return [...active]; },
    getAllTools() { return [...active.map((name) => ({ name })), ...[...tools.values()].map((tool) => ({ name: tool.name }))]; },
    setActiveTools(names) { active = [...names]; },
    appendEntry(customType, data) {
      if (pi.failAppend) throw new Error("persistence failed");
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    activeNames() { return [...active]; },
    branch() { return entries; },
  };
  extensionFactory(pi, async () => (Object.hasOwn(options, "launchPreflight") ? options.launchPreflight : (request) => launchProjection(request)));
  return pi;
}

const ctx = (pi, overrides = {}) => ({
  cwd: "/tmp/compass-project",
  mode: "tui",
  hasUI: true,
  ui: { notify() {}, custom: async () => undefined },
  sessionManager: { getBranch: () => pi.branch() },
  ...overrides,
});

let sequence = 0;
async function boot(pi) {
  await pi.hooks.get("session_start")[0]({}, ctx(pi));
}
function stateOf(pi) {
  return pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1)?.data;
}
function receipt(result) {
  assert.equal(result.isError, undefined, `tool returned an error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}
async function call(pi, name, params, context = ctx(pi), { dispatch = true } = {}) {
  const tool = pi.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  const result = await tool.execute(`${name}-${++sequence}`, params, undefined, undefined, context);
  if (dispatch && (name === "compass_goal" || name === "compass_plan")) {
    for (const handler of pi.hooks.get("tool_result") ?? []) await handler({ toolName: name, content: result.content, details: result.details, isError: Boolean(result.isError) }, context);
  }
  return result;
}
async function view(pi, params = {}, context = ctx(pi)) {
  return receipt(await call(pi, "compass_state", params, context, { dispatch: false }));
}
async function sendHuman(pi, text) {
  const id = `human-${pi.entries.filter((entry) => entry.message?.role === "user").length + 1}`;
  pi.entries.push({ id, type: "message", message: { role: "user", content: text } });
  for (const handler of pi.hooks.get("before_agent_start") ?? []) await handler({ prompt: text }, ctx(pi));
  return id;
}
async function setGoal(pi, current, { constraints = [], criteria = ["Goal result is supported by observed evidence"] } = {}) {
  await sendHuman(pi, current);
  return receipt(await call(pi, "compass_goal", {
    action: "set", current, constraints, criteria,
  }));
}
function persistAssistantCall(pi, callId, name, args) {
  pi.entries.push({ id: `assistant-${callId}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] } });
}
async function present(pi, callId, context = ctx(pi)) {
  const prompt = (await view(pi, { view: "plan" }, context)).prompt;
  assert.ok(prompt, "an unapproved DAG exposes a native proposal prompt");
  persistAssistantCall(pi, callId, "ask_user_question", prompt);
  const event = { toolName: "ask_user_question", toolCallId: callId, input: structuredClone(prompt) };
  const patch = await pi.hooks.get("tool_call")[0](event, context);
  return { event, patch };
}
async function answer(pi, callId, questions, { transform = (answers) => answers, context = ctx(pi) } = {}) {
  const details = { answers: transform(exactAnswers(questions)) };
  for (const handler of pi.hooks.get("tool_result") ?? []) {
    await handler({ toolName: "ask_user_question", toolCallId: callId, isError: false, content: [{ type: "text", text: "Human answered the proposal" }], details }, context);
  }
  return details;
}
const criteria = ["API route is evidenced", "UI route is evidenced"];
const tasks = [
  { id: "api", title: "Inspect API", acceptance: "API route documented", executor: "subagent", agent: "scout", writeScope: "read-only", dispatchReason: "Independent route tracing benefits from a separate semantic context." },
  { id: "ui", title: "Inspect UI", acceptance: "UI route documented", executor: "subagent", agent: "scout", writeScope: "read-only", dispatchReason: "Independent UI tracing benefits from a separate semantic context." },
];
async function plannedGoal(pi, goalTasks = tasks) {
  await boot(pi);
  await setGoal(pi, "Document the full-stack smoke path", { criteria });
  await call(pi, "compass_plan", { action: "define", tasks: goalTasks });
  return stateOf(pi);
}
async function approve(pi, context = ctx(pi)) {
  const callId = `approval-${++sequence}`;
  const { event, patch } = await present(pi, callId, context);
  assert.equal(patch, undefined, "supported interactive UI expands the proposal in place");
  await answer(pi, callId, event.input.questions, { context });
  assert.equal(dagApprovalStatus(stateOf(pi)).approved, true, "both exact approvals authorize this DAG");
}

test("registers the fixed Compass tools and preserves the native loadout", async () => {
  const pi = fakePi();
  await boot(pi);
  assert.deepEqual([...pi.tools.keys()].sort(), ["compass_acceptance", "compass_context", "compass_context_search", "compass_goal", "compass_plan", "compass_state", "runtime_guard"]);
  assert.ok(pi.activeNames().includes("compass_goal"));
  assert.ok(pi.activeNames().includes("compass_context"));
  assert.ok(pi.activeNames().includes("runtime_guard"));
  assert.equal(pi.commands?.has("compass-preflight"), true);
});

test("Compass tools recover after a host loadout reset", async () => {
  const pi = fakePi();
  await boot(pi);
  const native = pi.activeNames().filter((name) => !name.startsWith("compass_") && name !== "runtime_guard");
  pi.setActiveTools(native);
  assert.equal(pi.activeNames().includes("compass_goal"), false);
  await pi.hooks.get("turn_end").at(-1)({ entries: [] }, ctx(pi));
  assert.ok(pi.activeNames().includes("compass_goal"));
  pi.setActiveTools(native);
  await pi.hooks.get("before_agent_start")[0]({ prompt: "Continue the current work" }, ctx(pi));
  assert.ok(pi.activeNames().includes("compass_goal"));
  assert.ok(pi.activeNames().includes("compass_plan"));
  assert.ok(pi.activeNames().includes("runtime_guard"));
  assert.deepEqual(pi.activeNames().filter((name) => !name.startsWith("compass_") && name !== "runtime_guard"), native);
});

test("Human prose is observed without creating, replacing or classifying a Goal", async () => {
  const pi = fakePi();
  await boot(pi);
  const humanId = await sendHuman(pi, "Please look into the flaky build when you can");
  const summary = await view(pi);
  assert.equal(summary.goal, null, "prose never becomes a Goal");
  assert.equal(summary.input.ref, humanSourceRef(pi.branch(), humanId));
  assert.equal(summary.input.reviewed, undefined, "no Goal exists to review the input against");
});

test("Goal alone defines criteria; decisions and checkpoints stay Goal-scoped", async () => {
  const pi = fakePi();
  await boot(pi);
  const created = await setGoal(pi, "Create a repeatable smoke test", { constraints: ["No new dependencies"], criteria });
  assert.deepEqual(created.criteria, [{ id: "AC1", text: criteria[0] }, { id: "AC2", text: criteria[1] }]);
  const decided = receipt(await call(pi, "compass_goal", { action: "decide", summary: "Use the existing Playwright harness", rationale: "It already boots both layers." }));
  assert.match(decided.decision, /^D1$/);
  const checkpoint = receipt(await call(pi, "compass_goal", { action: "checkpoint", ref: "git:abc123", note: "Baseline before edits" }));
  assert.match(checkpoint.checkpoint, /^C1$/);
  const goal = await view(pi, { view: "goal" });
  assert.deepEqual(goal.criteria.map((item) => item.id), ["AC1", "AC2"]);
  assert.equal(goal.decisions[0].summary, "Use the existing Playwright harness");
  assert.equal(goal.checkpoints[0].ref, "git:abc123");
  const acceptance = await view(pi, { view: "acceptance" });
  assert.equal(acceptance.status, "active");
  assert.equal(acceptance.independentlyVerified, false);
});

test("Goal drafts need no refs and invalid criteria leave state untouched", async () => {
  const pi = fakePi();
  await boot(pi);
  await setGoal(pi, "Keep the current behaviour intact");
  const before = structuredClone(stateOf(pi));
  assert.ok(before.goal.approvalRequest, "semantic Goal produces an approval proposal without provenance arguments");
  await assert.rejects(() => call(pi, "compass_goal", { action: "set", current: "Different objective", constraints: [], criteria: ["", "duplicate", "duplicate"] }), /No state changed/);
  assert.deepEqual(stateOf(pi), before);
});

test("a DAG is a draft, requires Goal criteria, and rejects unsafe or unexplained Subagent tasks", async () => {
  const pi = fakePi();
  await boot(pi);
  await sendHuman(pi, "Map both layers");
  await call(pi, "compass_goal", { action: "set", current: "Map both layers", constraints: [] });
  const revision = stateOf(pi).stateRevision;
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks }), /Define Goal acceptance criteria/);
  await call(pi, "compass_goal", { action: "set", current: "Map both layers", constraints: [], criteria });
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks: [{ ...tasks[0], writeScope: "src/api" }, tasks[1]] }), /read-only/);
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks: [{ ...tasks[0], dispatchReason: "useful" }, tasks[1]] }), /dispatchReason/);
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks: [tasks[0]] }), /at least two|2/);
  assert.equal(stateOf(pi).stateRevision, revision + 1, "only the criteria change mutated state");
  await call(pi, "compass_plan", { action: "define", tasks });
  const plan = await view(pi, { view: "plan" });
  assert.equal(plan.approval, "awaiting_questionnaire", "define alone never authorizes execution");
  assert.match(plan.next, /ask_user_question tool directly, outside Code Mode/);
  const replay = receipt(await call(pi, "compass_plan", { action: "request_approval" }));
  assert.equal(replay.unchanged, true);
  assert.deepEqual(replay.prompt, plan.prompt, "request_approval reuses a valid unpresented proposal");
  assert.equal(plan.ready, undefined, "nothing is ready before Human approval");
  assert.ok(plan.prompt, "the native prompt carries only an opaque proposal ref");
  assert.equal(JSON.stringify(plan.prompt).includes("Tasks (DAG revision"), false, "the exact proposal is not duplicated into the model transcript");
  const replacement = await setGoal(pi, "Map a different service", { criteria });
  assert.equal(replacement.planReset, true);
  const beforePatch = stateOf(pi);
  await assert.rejects(() => call(pi, "compass_plan", { action: "patch", upsertTasks: tasks }), /no current DAG.*action:"define".*No state changed/i);
  assert.deepEqual(stateOf(pi), beforePatch);
});

test("incremental Goal and DAG edits preserve unrelated evidence and require fresh approval", async () => {
  const pi = fakePi();
  await plannedGoal(pi);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.tasks.every((task) => task.status === "done"), "both original nodes complete");
  await call(pi, "compass_acceptance", { results: [{ criterion: "AC1", status: "reported_pass", evidence: "API observation retained" }] });
  const { goal: original } = await view(pi, { view: "goal" });
  const updated = receipt(await call(pi, "compass_goal", { action: "update", constraintEdits: [{ text: "Follow AGENTS.md#toolresult-design" }], criterionEdits: [{ id: "AC2", text: "UI route includes error handling" }] }));
  assert.equal(updated.goalApproval, "awaiting_questionnaire");
  assert.equal(updated.approval, "approved");
  assert.deepEqual(updated.prompt.questions.map(({ header }) => header), ["Goal"]);
  await approve(pi);
  assert.equal((await view(pi, { view: "goal" })).goal.current, original.current);
  assert.equal((await view(pi, { view: "acceptance" })).criteria[0].status, "reported_pass");
  assert.deepEqual(updated.criteria.map((item) => item.id), ["AC1", "AC3"]);
  await assert.rejects(() => call(pi, "compass_goal", { action: "update", criterionEdits: [{ id: "AC2" }] }), /stale.*criterion/i);
  const edited = receipt(await call(pi, "compass_plan", { action: "patch", upsertTasks: [{ id: "ui", acceptance: "Successful and failing UI paths documented" }] }));
  assert.deepEqual(edited.diff, { added: [], changed: ["ui"], removed: [] });
  assert.match(edited.warnings[0], /No dependencies/);
  assert.deepEqual(stateOf(pi).plan.tasks.map((task) => task.status), ["done", "pending"]);
  assert.equal(pi.delegation.length, 2, "a definition edit is not launch authorization");
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.tasks[1].status === "done", "the revised node alone completes");
  assert.deepEqual(pi.delegation.map((request) => request.nodeId), ["api", "ui", "ui"]);
});

test("a Goal approval with delivery notes leads to one revised Goal+DAG prompt, not a DAG-only detour", async () => {
  const pi = fakePi();
  await boot(pi);
  const goal = await setGoal(pi, "Deliver the fix");
  const { event } = await present(pi, "qualified-goal");
  await answer(pi, "qualified-goal", event.input.questions, {
    transform: ([answer]) => [{ ...answer, notes: "Deliver separate PRs to master and the release branch." }],
  });
  const draft = receipt(await call(pi, "compass_plan", { action: "define", tasks: [
    { id: "deliver", title: "Deliver", acceptance: "Both PRs exist", executor: "parent" },
    { id: "verify", title: "Verify PR targets", acceptance: "Both bases confirmed", dependsOn: ["deliver"], executor: "code" },
  ] }));
  assert.equal(draft.goalApproval, "modified");
  assert.equal(draft.prompt, undefined);
  assert.match(draft.next, /compass_goal.*compass_plan request_approval/);
  assert.match(goal.next, /define.*DAG first/);
  await assert.rejects(() => call(pi, "compass_plan", { action: "start", taskIds: ["deliver"] }), /Goal.*not approved/);
  const updated = receipt(await call(pi, "compass_goal", { action: "update", constraintEdits: [{ text: "Deliver separate PRs to master and the release branch." }] }));
  assert.deepEqual(updated.prompt.questions.map(({ header }) => header), ["Goal", "DAG"]);
});

test("an expired proposal is a corrective block, not a host error", async () => {
  const pi = fakePi();
  await plannedGoal(pi);
  const state = stateOf(pi);
  state.plan.approvalRequest.id = "renewed-elsewhere";
  const callId = "approval-expired";
  const prompt = { questions: [{ question: "Review this Compass proposal?", header: "Compass", multiSelect: false, options: [{ label: "Review proposal", description: "Open the exact proposal for your decision.", preview: `P.${state.plan.approvalRequest.id}` }] }] };
  persistAssistantCall(pi, callId, "ask_user_question", prompt);
  const patch = await pi.hooks.get("tool_call")[0]({ toolName: "ask_user_question", toolCallId: callId, input: structuredClone(prompt) }, ctx(pi));
  assert.equal(patch?.block, true);
  assert.match(patch.reason, /expired|fresh proposal|No state changed/);
  assert.equal(stateOf(pi).plan.approval, null);
});

test("approval fails closed without interactive full-preview TUI", async () => {
  const pi = fakePi();
  await plannedGoal(pi);
  const callId = "approval-rpc";
  const prompt = (await view(pi, { view: "plan" })).prompt;
  persistAssistantCall(pi, callId, "ask_user_question", prompt);
  for (const context of [ctx(pi, { mode: "rpc", hasUI: true, ui: { notify() {} } }), ctx(pi, { mode: "print" }), ctx(pi, { mode: "json" }), ctx(pi, { hasUI: false }), ctx(pi, { ui: { notify() {} } })]) {
    const patch = await pi.hooks.get("tool_call")[0]({ toolName: "ask_user_question", toolCallId: callId, input: structuredClone(prompt) }, context);
    assert.equal(patch?.block, true);
    assert.match(patch.reason, /interactive Pi with full-preview TUI/);
  }
  const state = stateOf(pi);
  assert.equal(state.plan.approvalRequest.toolCallId, undefined, "a blocked presentation cannot bind the request");
  assert.equal(state.plan.approval, null);
});

test("a shortened preview echo cannot authorize the exact DAG", async () => {
  const pi = fakePi();
  await plannedGoal(pi);
  const callId = "approval-short";
  const { event } = await present(pi, callId);
  await answer(pi, callId, event.input.questions, { transform: (answers) => answers.map((answer) => ({ ...answer, preview: answer.preview.slice(0, 60) })) });
  const state = stateOf(pi);
  assert.equal(dagApprovalStatus(state).approved, false);
  assert.equal(state.plan.approval, null);
  assert.equal(state.plan.approvalRequest.status, "modified", "an unverified echo is recorded as a modification, not approval");
});

test("interactive approval dispatches exactly the read-only Subagent wave and consumes structured results", async () => {
  const pi = fakePi();
  await plannedGoal(pi);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.executionHistory?.length === 1, "the approved wave completes");
  assert.deepEqual(pi.delegation.map((request) => request.nodeId).sort(), ["api", "ui"], "only the exactly approved read-only tasks were dispatched");
  assert.equal(pi.delegation.every((request) => request.context === "fresh" && request.agent === "scout" && request.task.includes("Inspect")), true);
  const state = stateOf(pi);
  assert.equal(state.plan.tasks.every((task) => task.status === "done" && task.evidence.includes("src/")), true);
  assert.equal(state.plan.executionHistory[0].status, "completed");
  assert.equal(state.plan.executionHistory[0].totalCost, 0.002);
  const summary = await view(pi);
  assert.equal(summary.plan.done, 2);
  assert.equal(summary.plan.remaining, 0);
  assert.equal(summary.outcome, "incomplete", "child completion is not Goal acceptance");
});

test("an uncertain dispatch keeps its correlation and absorbs the late terminal result", async () => {
  const pi = fakePi({ faultDispatch: true });
  await plannedGoal(pi);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.executions[0]?.status === "unknown", "both faulted dispatches are recorded");
  const state = stateOf(pi);
  assert.deepEqual(state.plan.executions[0].results.map((item) => item.status), ["unknown", "unknown"], "a faulted dispatch is unknown, never done");
  assert.equal(state.plan.executions[0].status, "unknown", "an uncertain batch is not presented as completed");
  assert.equal(state.plan.tasks.every((task) => task.status === "in_progress"), true);
  assert.equal(pi.delegation.length, 2);

  // A terminal event that arrives after the fault is evidence for that exact
  // request. Dropping it would leave the task unrecoverable without a re-dispatch.
  const accepted = pi.delegation[0];
  pi.events.emit("prompt-template:subagent:response", {
    requestId: accepted.requestId,
    ownerRunId: accepted.ownerRunId,
    nodeId: accepted.nodeId,
    status: "completed",
    runId: "run-late",
    model: accepted.model,
    result: { kind: "structured", value: { status: "done", summary: "Late inspection finished.", evidence: ["src/late.ts:1"], reason: "" } },
    usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 1, durationMs: 10 },
  });
  await waitFor(() => stateOf(pi).plan.tasks.find((task) => task.id === accepted.nodeId)?.status === "done", "the late terminal result is reconciled");
  const reconciled = stateOf(pi).plan.executions[0].results.find((item) => item.id === accepted.nodeId);
  assert.equal(reconciled.status, "done");
  assert.equal(reconciled.runId, "run-late", "the late result stays bound to its original request");
  assert.equal(stateOf(pi).plan.executions[0].status, "unknown", "one late result cannot settle the remaining unknown child");
  assert.equal(stateOf(pi).plan.executionHistory.length, 0);

  const remaining = pi.delegation[1];
  const terminal = {
    requestId: remaining.requestId, ownerRunId: remaining.ownerRunId, nodeId: remaining.nodeId,
    status: "cancelled", error: "Native cancellation confirmed", model: remaining.model,
  };
  pi.events.emit("prompt-template:subagent:response", terminal);
  pi.events.emit("prompt-template:subagent:response", terminal);
  await waitFor(() => stateOf(pi).plan.executions[0].status === "completed", "the last late terminal result settles the batch");
  const settled = stateOf(pi);
  assert.equal(settled.plan.executionHistory.length, 1, "settlement is recorded only once");
  assert.equal(settled.plan.tasks.find((task) => task.id === remaining.nodeId).status, "blocked");
  assert.equal(pi.delegation.length, 2, "an unknown outcome never triggers a second dispatch");
});

test("an invalid terminal retains correlation; valid late evidence releases independent ready work", async () => {
  const valid = { status: "completed", result: { kind: "structured", value: {
    status: "done", summary: "Inspected route", evidence: ["src/route.ts:1"], reason: "",
  } } };
  const pi = fakePi({ respondDelegation: (request) => {
    if (request.nodeId === "api") return { ...valid, model: "other/model" };
    return request.nodeId === "follow" ? valid : null;
  } });
  await plannedGoal(pi, [...tasks, ...["two", "three", "follow"].map((id) => ({ ...tasks[1], id }))]);
  await approve(pi);
  const terminal = (request, value) => pi.events.emit("prompt-template:subagent:response", { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...value });
  try {
    await waitFor(() => stateOf(pi).plan.executions[0]?.status === "unknown", "the malformed response enters recovery");
    assert.equal(pi.delegation.length, 4, "capacity and unknown both prevent another dispatch");
    terminal(pi.delegation[1], valid);
    assert.equal(pi.delegation.length, 4, "unknown still blocks despite available capacity");
    terminal(pi.delegation[0], valid);
    await waitFor(() => stateOf(pi).plan.tasks[0].status === "done", "the later valid response settles the original attempt", 500);
    await waitFor(() => stateOf(pi).plan.tasks[4].status === "done", "the independent ready node starts without another tool call", 500);
    assert.equal(pi.delegation.filter((request) => request.nodeId === "api").length, 1);
  } finally {
    for (const request of pi.delegation) terminal(request, valid);
    await pi.hooks.get("session_shutdown")[0]({}, ctx(pi));
  }
});

test("a terminal result is recorded while an unrelated sibling is still running", async () => {
  const sibling = Promise.withResolvers();
  const done = { status: "completed", result: { kind: "structured", value: {
    status: "done", summary: "Verified the route", evidence: ["src/api.ts:1"], reason: "",
  } } };
  const pi = fakePi({ respondDelegation: (request) => request.nodeId === "api" ? done : sibling.promise });
  await plannedGoal(pi);
  await approve(pi);
  try {
    await waitFor(() => stateOf(pi).plan.tasks[0].status === "done", "the first result without releasing the sibling", 500);
    assert.equal(stateOf(pi).plan.tasks[1].status, "in_progress");
    assert.equal(stateOf(pi).plan.executionHistory.length, 0);
  } finally {
    sibling.resolve(done);
    await waitFor(() => stateOf(pi).plan.executions[0].status === "completed", "the sibling settles");
  }
});

test("an assessed successor starts while an unrelated native child is still running", async () => {
  const sibling = Promise.withResolvers();
  const done = { status: "completed", result: { kind: "structured", value: {
    status: "done", summary: "Inspected a route", evidence: ["src/api.ts:1"], reason: "",
  } } };
  const pi = fakePi({ respondDelegation: (request) => request.nodeId === "ui" ? sibling.promise : done });
  await plannedGoal(pi, [...tasks, { ...tasks[0], id: "follow", dependsOn: ["api"] }]);
  await approve(pi);
  try {
    await waitFor(() => stateOf(pi).plan.tasks[0].status === "done", "the prerequisite result becomes available");
    assert.deepEqual(pi.delegation.map((request) => request.nodeId), ["api", "ui"]);
    await call(pi, "compass_plan", { action: "assess", taskId: "api", status: "pass", evidence: "Checked src/api.ts:1 against the approved route." });
    await waitFor(() => stateOf(pi).plan.tasks[2].status === "done", "the successor finishes without releasing the sibling", 500);
    assert.equal(stateOf(pi).plan.tasks[1].status, "in_progress");
  } finally {
    sibling.resolve(done);
    await waitFor(() => stateOf(pi).plan.tasks[1].status === "done", "the sibling terminates");
  }
  assert.deepEqual(pi.delegation.map((request) => request.nodeId), ["api", "ui", "follow"]);
  assert.equal(stateOf(pi).plan.executionHistory.length, 2);
});

test("a delegated throw freezes progression and cancellation targets one exact sibling attempt", async () => {
  const sibling = Promise.withResolvers();
  const stopped = { status: "completed", result: { kind: "structured", value: {
    status: "throw", summary: "Wrong checkout", evidence: ["src/api.ts imports the retired router"],
    reason: "The approved plan targets the retired router.", sideEffects: "No writes observed.",
  } } };
  const pi = fakePi({ respondDelegation: (request) => request.nodeId === "api" ? stopped : sibling.promise });
  const cancels = [];
  pi.events.on("prompt-template:subagent:cancel", (request) => cancels.push(request));
  const next = { id: "next", title: "Write notes", acceptance: "Notes point to the correct router", executor: "parent" };
  await plannedGoal(pi, [...tasks, next]);
  await approve(pi);
  try {
    await waitFor(() => stateOf(pi).plan.tasks[0].status === "blocked", "the stop report is consumed");
    const plan = await view(pi, { view: "plan" });
    assert.equal(plan.ready, undefined);
    assert.equal(plan.stopped.taskId, "api");
    assert.equal(plan.stopped.sideEffects, "No writes observed.");
    assert.deepEqual(pi.notices.map(({ message, options, stopped: committed }) => ({ type: message.customType, options, taskId: committed?.taskId })), [
      { type: "pi-compass-v2.plan-stop", options: { triggerTurn: true, deliverAs: "steer" }, taskId: "api" },
    ], "the first correlated stop requests one native wake after persistence");
    assert.match(pi.notices[0].message.content, /approved plan targets the retired router/);
    assert.equal((await view(pi)).plan.stoppedBy, "api");
    assert.equal(cancels.length, 0, "a throw does not cancel siblings by itself");
    const active = pi.delegation.find((request) => request.nodeId === "ui");
    const request = { action: "cancel", taskId: "ui", requestId: active.requestId };
    await assert.rejects(() => call(pi, "compass_plan", { ...request, requestId: "stale" }), /exact.*attempt/i);
    receipt(await call(pi, "compass_plan", request));
    receipt(await call(pi, "compass_plan", request));
    assert.deepEqual(cancels, [{ requestId: active.requestId, ownerRunId: active.ownerRunId, nodeId: "ui" }]);
    assert.equal(stateOf(pi).plan.tasks[1].status, "in_progress", "asking to cancel is not terminal evidence");
    assert.equal(stateOf(pi).plan.executions[0].results[1].cancelRequested, true);
    await assert.rejects(() => call(pi, "compass_plan", { action: "start", taskIds: ["next"] }), /DAG was stopped/);
  } finally {
    sibling.resolve({ status: "cancelled", error: "Native cancellation confirmed" });
    await waitFor(() => stateOf(pi).plan.executions[0].status === "completed", "the native terminal response settles the sibling");
  }
  assert.equal(stateOf(pi).plan.tasks[2].status, "pending");
  assert.equal(pi.delegation.length, 2);
  assert.equal(pi.notices.length, 1, "settling a sibling does not request another wake");
});

test("a delegated throw commits during a sibling fallback preflight and suppresses that launch", { timeout: 2000 }, async () => {
  const stop = Promise.withResolvers();
  const checkingFallback = Promise.withResolvers();
  const releaseFallback = Promise.withResolvers();
  const pi = fakePi({
    respondDelegation: (request) => request.nodeId === "api" ? stop.promise : { status: "failed", error: "Provider returned 503" },
    launchPreflight: async (request) => {
      if (request.model === FALLBACK_MODEL) {
        checkingFallback.resolve();
        await releaseFallback.promise;
      }
      return launchProjection(request);
    },
  });
  await plannedGoal(pi);
  await approve(pi);
  await checkingFallback.promise;
  try {
    stop.resolve({ status: "completed", result: { kind: "structured", value: {
      status: "throw", summary: "Scope mismatch", evidence: ["README.md documents a different API"], reason: "The Goal needs a revised plan.",
    } } });
    await waitFor(() => pi.notices.length === 1, "the stop wakes main without waiting for sibling preflight", 150);
  } finally {
    releaseFallback.resolve();
    await waitFor(() => stateOf(pi).plan.executions[0].status === "completed", "the sibling failure is consumed", 500);
  }
  assert.equal(pi.delegation.length, 2, "the 503 cannot initiate a fallback after a stop");
  assert.match(stateOf(pi).plan.tasks[1].reason, /503/);
  assert.equal(stateOf(pi).plan.executionHistory[0].fallbackCount, 0);
});

test("new Human input pauses approved dispatch until the Agent reaffirms the Goal", async () => {
  const pi = fakePi({ respondDelegation: (request) => new Promise((resolve) => setTimeout(() => resolve({
    status: "completed", runId: `run-${request.nodeId}`, model: request.model,
    result: { kind: "structured", value: { status: "done", summary: "late child", evidence: ["src/late.ts:1"], reason: "" } },
    usage: { input: 1, output: 1, cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10 },
  }), 300)) });
  await plannedGoal(pi);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.executions[0]?.status === "running", "the approved wave starts");
  await sendHuman(pi, "Actually, also keep the existing flags unchanged.");
  assert.equal(dagApprovalStatus(stateOf(pi)).approved, false, "unreviewed Human input withdraws authorization");
  const plan = await view(pi, { view: "plan" });
  assert.equal(plan.approval, "stale", "an answered-but-withdrawn approval is reported as stale");
  await assert.rejects(() => call(pi, "compass_plan", { action: "assess", taskId: "api", status: "pass", evidence: "Verified route order.", caveats: [], unresolvedCaveats: [] }), /Review the latest Human input.*compass_goal/);
  await waitFor(() => stateOf(pi).plan.executions[0]?.status === "completed", "the already-started child terminal result is still consumed");
  assert.equal(stateOf(pi).plan.tasks.find((task) => task.id === "api").status, "done", "a correlated fact is preserved without reopening progression");
  assert.equal(pi.delegation.length, 2);
});

test("dependent Subagent work waits for a current semantic assessment, and Code Mode tasks are never dispatched", async () => {
  const pi = fakePi();
  const goalTasks = [
    tasks[0],
    { id: "impl", title: "Implement smoke path", acceptance: "A real path is exercised", dependsOn: ["api"], executor: "code", writeScope: "src/smoke" },
  ];
  await plannedGoal(pi, goalTasks);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.tasks.find((task) => task.id === "api").status === "done", "the first wave completes");
  assert.deepEqual(pi.delegation.map((request) => request.nodeId), ["api"], "an unassessed prerequisite does not release dependent work");
  await assert.rejects(() => call(pi, "compass_plan", { action: "assess", taskId: "impl", status: "pass", evidence: "not started yet", caveats: [], unresolvedCaveats: [] }), /No assessment was recorded|approval/);
  await call(pi, "compass_plan", { action: "assess", taskId: "api", status: "pass", evidence: "Route table and middleware order verified in src/api.ts.", caveats: [], unresolvedCaveats: [] });
  const started = receipt(await call(pi, "compass_plan", { action: "start", taskIds: ["impl"] }));
  assert.deepEqual(started.affected, ["impl"]);
  assert.equal(pi.delegation.length, 1, "Code Mode execution stays with the parent Agent");
  const done = receipt(await call(pi, "compass_plan", { action: "done", tasks: [{ id: "impl", evidence: "Navigation exercises /api/health through the real router." }] }));
  assert.deepEqual(done.affected, ["impl"]);
});

test("unavailable launch preflight leaves all candidates pending with a plan-visible reason", async () => {
  const pi = fakePi({ launchPreflight: null });
  await plannedGoal(pi);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.executions[0]?.status === "failed", "preflight refusal is visible");
  const plan = await view(pi, { view: "plan" });
  assert.match(plan.dispatchIssue, /Cannot resolve.*launch preflight/);
  assert.equal(pi.delegation.length, 0);
  assert.ok(plan.tasks.every((task) => task.status === "pending"));
});

test("a refused child does not delay safe work and only the reopened node retries", async () => {
  let profileFixed = false;
  const pi = fakePi({ launchPreflight: (request) => launchProjection(request, !profileFixed && request.agent === "scout" ? ["write"] : ["read"]) });
  const unsafe = Array.from({ length: 7 }, (_, idx) => ({ ...tasks[0], id: `unsafe${idx}` }));
  await plannedGoal(pi, [...unsafe, { ...tasks[1], agent: "delegate" }, { ...tasks[1], id: "dependent", dependsOn: [unsafe[0].id] }]);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.tasks.find((task) => task.id === "ui").status === "done", "the safe child completes");
  const plan = await view(pi, { view: "plan" });
  assert.deepEqual(pi.delegation.map(({ nodeId }) => nodeId), ["ui"]);
  assert.equal(plan.tasks.find(({ id }) => id === "dependent").status, "pending");
  for (const task of plan.tasks.slice(0, unsafe.length)) {
    assert.equal(task.status, "blocked");
    assert.match(task.reason, /outside the read-only role: write.*No child was dispatched.*reopen/);
  }
  profileFixed = true;
  const retry = receipt(await call(pi, "compass_plan", { action: "reopen", tasks: [{ id: unsafe[0].id, reason: "Restore the read-only profile" }] }));
  assert.deepEqual(retry.affected, [unsafe[0].id, "dependent"]);
  await waitFor(() => stateOf(pi).plan.tasks[0].status === "done", "only the repaired node completes");
  assert.deepEqual(pi.delegation.map(({ nodeId }) => nodeId), ["ui", unsafe[0].id]);
  assert.equal(stateOf(pi).plan.tasks[1].status, "blocked");
  await call(pi, "compass_plan", { action: "reopen", tasks: [{ id: "ui", reason: "Verify terminal re-execution is scoped" }] });
  await waitFor(() => pi.delegation.length === 3 && stateOf(pi).plan.tasks.find(({ id }) => id === "ui").status === "done", "terminal node reruns once");
  assert.deepEqual(pi.delegation.map(({ nodeId }) => nodeId), ["ui", unsafe[0].id, "ui"]);
  assert.notEqual(pi.delegation[0].requestId, pi.delegation[2].requestId);
});

test("preflight does not hold Goal state open or launch an obsolete plan", { timeout: 2000 }, async () => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let held = true;
  const pi = fakePi({ launchPreflight: async (request) => {
    if (held) { entered.resolve(); await gate.promise; }
    return launchProjection(request);
  } });
  await plannedGoal(pi);
  await approve(pi);
  await entered.promise;
  try {
    const discarded = receipt(await call(pi, "compass_plan", { action: "discard" }));
    assert.equal(discarded.plan, null);
    await call(pi, "compass_plan", { action: "define", tasks: tasks.map((task) => ({ ...task, id: `new-${task.id}` })) });
    await approve(pi);
  } finally {
    held = false;
    gate.resolve();
  }
  await waitFor(() => stateOf(pi).plan.tasks.every((task) => task.status === "done"), "the newly approved plan runs", 1000);
  assert.deepEqual(pi.delegation.map(({ nodeId }) => nodeId), ["new-api", "new-ui"]);
});

test("a fallback is refused when its launch no longer proves a read-only profile", async () => {
  const checked = [];
  const pi = fakePi({
    launchPreflight: (request) => launchProjection(request, checked.push(request.agent) === 1 ? ["read"] : ["read", "write"]),
    respondDelegation: () => ({ status: "failed", error: "503 provider unavailable" }),
  });
  await plannedGoal(pi, [tasks[0], { ...tasks[1], executor: "parent" }]);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.executions[0]?.status === "completed", "the primary terminal result is preserved");
  assert.equal(checked.length, 2, "fallback uses a fresh launch check");
  assert.equal(pi.delegation.length, 1);
  assert.equal(stateOf(pi).plan.tasks[0].status, "blocked");
  assert.match(stateOf(pi).plan.tasks[0].reason, /Fallback refused:.*outside the read-only role: write/);
});

test("a missing structured-delegation handler fails closed without launching a child", async () => {
  const pi = fakePi({ bus: false });
  await plannedGoal(pi);
  // Approve through the module binding path: this test isolates the dispatch bridge.
  const callId = "approval-no-bus";
  const { event } = await present(pi, callId);
  // Without a bus the hook still binds; the questionnaire answer is correlated normally.
  await answer(pi, callId, event.input.questions);
  await waitFor(() => stateOf(pi).plan.executions[0]?.status === "failed", "dispatch fails visibly");
  const state = stateOf(pi);
  assert.match(state.plan.executions[0].error, /No correlated invalid_request response|does not expose the structured-delegation contract/);
  assert.equal(state.plan.tasks.every((task) => task.status === "pending"), true, "no task is presumed started");
  assert.deepEqual(pi.delegation, []);
});

test("session shutdown marks an unresolved dispatch unknown and reconciliation requires native evidence", async () => {
  const slow = { respondDelegation: (request) => new Promise((resolve) => setTimeout(() => resolve({
    status: "completed", runId: `run-${request.nodeId}`, model: request.model,
    result: { kind: "structured", value: { status: "done", summary: `Inspected ${request.nodeId}.`, evidence: [`src/${request.nodeId}.ts:1`], reason: "" } },
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 2, durationMs: 100 },
  }), 500)) };
  const pi = fakePi(slow);
  await plannedGoal(pi);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.executions[0]?.status === "running", "a wave is in flight");
  await pi.hooks.get("session_shutdown")[0]({}, ctx(pi));
  const unknown = stateOf(pi);
  assert.equal(unknown.plan.executions[0].status, "unknown", "an in-flight batch is never presumed stopped or restarted");
  // A restarted Pi session is a new extension instance over the same native branch.
  const restarted = fakePi({ ...slow, entries: pi.entries });
  await boot(restarted);
  await assert.rejects(() => call(restarted, "compass_plan", { action: "start", taskIds: ["api"] }), /unresolved native batch|No state changed/);
  await assert.rejects(() => call(restarted, "compass_plan", {
    action: "resolve", requestId: unknown.plan.executions[0].requestId, confirmedNoActiveRuns: true,
    confirmationEvidence: "short", results: unknown.plan.executions[0].taskIds.map((id) => ({ id, status: "done", evidence: "checked" })),
  }), /confirmationEvidence/);
  await call(restarted, "compass_plan", {
    action: "resolve", requestId: unknown.plan.executions[0].requestId, confirmedNoActiveRuns: true,
    confirmationEvidence: "Native subagent status shows both recorded child runs terminal.",
    results: unknown.plan.executions[0].taskIds.map((id) => ({ id, status: "blocked", reason: "Child run terminal without usable evidence." })),
  });
  const state = stateOf(restarted);
  assert.equal(state.plan.executions[0].status, "completed");
  assert.equal(state.plan.tasks.every((task) => task.status === "blocked"), true);
  assert.equal(pi.delegation.length, 2, "the unknown batch was not redispatched");
});

test("acceptance records only existing criteria and repeated identical evidence is a no-op", async () => {
  const pi = fakePi();
  await boot(pi);
  await setGoal(pi, "Prove the smoke path", { criteria });
  const revision = stateOf(pi).stateRevision;
  await assert.rejects(() => call(pi, "compass_acceptance", { results: [{ criterion: "AC9", status: "reported_pass", evidence: "invented" }] }), /No state changed/);
  await assert.rejects(() => call(pi, "compass_acceptance", { results: [{ criterion: "AC1", status: "reported_pass", evidence: "one" }, { criterion: "AC1", status: "failed", evidence: "two" }] }), /once per batch/);
  assert.equal(stateOf(pi).stateRevision, revision);
  const result = receipt(await call(pi, "compass_acceptance", { results: [{ criterion: "AC1", status: "reported_pass", evidence: "Ran npm test; 12/12 passed." }] }));
  assert.equal(result.outcome, "incomplete");
  const first = stateOf(pi);
  await call(pi, "compass_acceptance", { results: [{ criterion: "AC1", status: "reported_pass", evidence: "Ran npm test; 12/12 passed." }] });
  assert.equal(stateOf(pi).stateRevision, first.stateRevision, "identical retry does not inflate state");
  const status = await view(pi, { view: "acceptance" });
  assert.equal(status.status, "active");
  assert.equal(status.passed, 1);
  assert.equal(status.unverified, 1);
});

test("only actual DAG drift is persisted; ordinary writes and errors stay in Pi", async () => {
  const pi = fakePi();
  await plannedGoal(pi, [
    { id: "ui", title: "Edit UI", acceptance: "UI updated", executor: "code", writeScope: "src/ui" },
    { id: "verify", title: "Review UI", acceptance: "Change verified", dependsOn: ["ui"], executor: "code" },
  ]);
  const write = (path) => pi.hooks.get("tool_call")[0]({ toolName: "edit", toolCallId: "write-1", input: { path } }, ctx(pi));
  const draftEntryCount = pi.entries.length;
  await write("docs/notes.md");
  await pi.hooks.get("tool_execution_end")[0]({ toolName: "edit", isError: true }, ctx(pi));
  assert.equal(pi.entries.length, draftEntryCount);
  await approve(pi);
  await call(pi, "compass_plan", { action: "start", taskIds: ["ui"] });
  const activeEntryCount = pi.entries.length;
  await write("src/ui/notes.md");
  assert.equal(pi.entries.length, activeEntryCount);
  assert.equal(await write("docs/notes.md"), undefined, "Compass never blocks a write by itself");
  assert.match(stateOf(pi).plan.executionDrift.reason, /outside every declared scope/);
  const driftEntryCount = pi.entries.length;
  await write("docs/notes.md");
  assert.equal(pi.entries.length, driftEntryCount, "repeated identical drift is a no-op");
});

test("native branch navigation adopts the selected branch GoalRun", async () => {
  const pi = fakePi();
  await boot(pi);
  await setGoal(pi, "Branch A objective");
  const branchA = pi.entries.length;
  pi.entries.push({ type: "custom", customType: "pi-compass-v2.goalrun", data: (() => {
    const other = normalizeGoalRunState(stateOf(pi));
    other.goal.current = "Branch B objective";
    other.stateRevision += 1;
    return other;
  })() });
  await pi.hooks.get("session_tree")[0]({}, ctx(pi));
  assert.equal(stateOf(pi).goal.current, "Branch B objective");
  pi.entries.length = branchA;
  await pi.hooks.get("session_tree")[0]({}, ctx(pi));
  assert.equal(stateOf(pi).goal.current, "Branch A objective");
});

test("an unsupported persisted GoalRun fails visibly instead of resetting state", async () => {
  const pi = fakePi();
  await boot(pi);
  pi.entries.push({ type: "custom", customType: "pi-compass-v2.goalrun", data: { schemaVersion: 9, goal: { current: "legacy" }, plan: { tasks: [] } } });
  await assert.rejects(() => pi.hooks.get("session_tree")[0]({}, ctx(pi)), /Unsupported Compass GoalRun schema/);
  assert.equal(pi.entries.at(-1).data.schemaVersion, 9, "raw history is preserved");
});

test("failed native persistence never reports a mutation as committed", async () => {
  const pi = fakePi();
  await boot(pi);
  await sendHuman(pi, "Persist a Goal");
  const persisted = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").length;
  pi.failAppend = true;
  await assert.rejects(() => call(pi, "compass_goal", {
    action: "set", current: "Persist a Goal", constraints: [], criteria,
  }), /persistence failed/);
  assert.equal(pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").length, persisted, "no candidate state is activated or persisted");
});

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
