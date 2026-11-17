import test from "node:test";
import assert from "node:assert/strict";
import extensionFactory from "../src/index.ts";
import { DAG_APPROVAL_OPTION, approvalPrompt } from "../src/dag-approval.mjs";
import { dagApprovalStatus, normalizeGoalRunState } from "../src/goal-run.mjs";
import { humanSourceRef, latestHumanSource } from "../src/goal-sources.mjs";

// Native extension surface: fixed eight tools, code-owned preconditions,
// interactive-only proposal expansion and structured-delegation consumption.
// These are installed-host adapters, not live AgentSession/provider acceptance.

function fakePi(options = {}) {
  const bus = new Map();
  const hooks = new Map();
  const tools = new Map();
  const entries = options.entries ?? [];
  const delegation = [];
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
    if (options.faultDispatch) throw new Error("delegation bridge faulted after accepting the request");
    queueMicrotask(() => {
      emit("prompt-template:subagent:started", { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId });
      const response = options.respondDelegation
        ? options.respondDelegation(request)
        : { status: "completed", runId: `run-${request.nodeId}`, model: request.model, result: { kind: "structured", value: { status: "done", summary: `Inspected ${request.nodeId}.`, evidence: [`src/${request.nodeId}.ts:1`], reason: "" } }, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 2, durationMs: 100 } };
      Promise.resolve(response).then((value) => value && emit("prompt-template:subagent:response", { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, ...value }));
    });
  });
  const pi = {
    hooks, tools, entries, delegation,
    events: { on: subscribe, emit },
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(definition) { tools.set(definition.name, definition); },
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
  extensionFactory(pi);
  return pi;
}

const ctx = (pi, overrides = {}) => ({
  cwd: "/tmp/compass-project",
  mode: "interactive",
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
    sources: [humanSourceRef(pi.branch(), latestHumanSource(pi.branch()))],
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
async function answer(pi, callId, canonical, { preview, option = DAG_APPROVAL_OPTION, context = ctx(pi) } = {}) {
  const details = { answers: [{ questionIndex: 0, question: canonical.question.slice(0, 400), kind: "option", answer: option, selected: [option], ...(preview === undefined ? {} : { preview }) }] };
  for (const handler of pi.hooks.get("tool_result") ?? []) {
    await handler({ toolName: "ask_user_question", toolCallId: callId, isError: false, content: [{ type: "text", text: `Human answered: ${option}` }], details }, context);
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
  const callId = `approval-${stateOf(pi).plan.approvalRequest.id}`;
  const { event, patch } = await present(pi, callId, context);
  assert.equal(patch, undefined, "supported interactive UI expands the proposal in place");
  const canonical = event.input.questions[0];
  assert.equal(canonical.options[0].label, DAG_APPROVAL_OPTION);
  await answer(pi, callId, canonical, { preview: canonical.options[0].preview, context });
  assert.equal(dagApprovalStatus(stateOf(pi)).approved, true, "exact correlated answer authorizes this DAG");
  return canonical;
}

test("registers exactly the eight fixed tools and never rewrites native activation", async () => {
  const pi = fakePi();
  await boot(pi);
  assert.deepEqual([...pi.tools.keys()].sort(), ["compass_acceptance", "compass_context", "compass_context_search", "compass_goal", "compass_plan", "compass_route", "compass_state", "runtime_guard"]);
  assert.deepEqual(pi.activeNames(), ["read", "bash", "edit", "write", "amend", "codemode", "subagent", "ask_user_question"]);
  assert.equal(pi.commands?.has("compass-preflight"), true);
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

test("Goal sources must be original native Human refs and failed writes leave state untouched", async () => {
  const pi = fakePi();
  await boot(pi);
  await setGoal(pi, "Keep the current behaviour intact");
  const before = structuredClone(stateOf(pi));
  await assert.rejects(() => call(pi, "compass_goal", { action: "set", current: "Keep the current behaviour intact", constraints: [], sources: ["S.not-a-human-ref.000000"] }), /No state changed/);
  assert.deepEqual(stateOf(pi), before);
  await assert.rejects(() => call(pi, "compass_goal", { action: "set", current: "Different objective", constraints: [], sources: [humanSourceRef(pi.branch(), latestHumanSource(pi.branch()))], criteria: ["", "duplicate", "duplicate"] }), /No state changed/);
  assert.deepEqual(stateOf(pi), before);
});

test("a DAG is a draft, requires Goal criteria, and rejects unsafe or unexplained Subagent tasks", async () => {
  const pi = fakePi();
  await boot(pi);
  await sendHuman(pi, "Map both layers");
  const sources = [humanSourceRef(pi.branch(), latestHumanSource(pi.branch()))];
  await call(pi, "compass_goal", { action: "set", current: "Map both layers", constraints: [], sources });
  const revision = stateOf(pi).stateRevision;
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks }), /Define Goal acceptance criteria/);
  await call(pi, "compass_goal", { action: "set", current: "Map both layers", constraints: [], sources, criteria });
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks: [{ ...tasks[0], writeScope: "src/api" }, tasks[1]] }), /read-only/);
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks: [{ ...tasks[0], dispatchReason: "useful" }, tasks[1]] }), /dispatchReason/);
  await assert.rejects(() => call(pi, "compass_plan", { action: "define", tasks: [tasks[0]] }), /at least two|2/);
  assert.equal(stateOf(pi).stateRevision, revision + 1, "only the criteria change mutated state");
  await call(pi, "compass_plan", { action: "define", tasks });
  const plan = await view(pi, { view: "plan" });
  assert.equal(plan.approval, "awaiting_questionnaire", "define alone never authorizes execution");
  assert.equal(plan.ready, undefined, "nothing is ready before Human approval");
  assert.ok(plan.prompt, "the native prompt carries only an opaque proposal ref");
  assert.equal(JSON.stringify(plan.prompt).includes("Tasks (DAG revision"), false, "the exact proposal is not duplicated into the model transcript");
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
  for (const context of [ctx(pi, { mode: "rpc", hasUI: true, ui: { notify() {} } }), ctx(pi, { mode: "print" }), ctx(pi, { mode: undefined, hasUI: false })]) {
    const patch = await pi.hooks.get("tool_call")[0]({ toolName: "ask_user_question", toolCallId: callId, input: structuredClone(prompt) }, context);
    assert.equal(patch?.block, true);
    assert.match(patch.reason, /interactive Pi with full-preview TUI/);
  }
  const state = stateOf(pi);
  assert.equal(state.plan.approvalRequest.toolCallId, "", "a blocked presentation cannot bind the request");
  assert.equal(state.plan.approval, null);
});

test("a shortened preview echo cannot authorize the exact DAG", async () => {
  const pi = fakePi();
  await plannedGoal(pi);
  const callId = "approval-short";
  const { event } = await present(pi, callId);
  const canonical = event.input.questions[0];
  await answer(pi, callId, canonical, { preview: canonical.options[0].preview.slice(0, 600) });
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
  await waitFor(() => stateOf(pi).plan.execution?.status === "unknown", "both faulted dispatches are recorded");
  const state = stateOf(pi);
  assert.deepEqual(state.plan.execution.results.map((item) => item.status), ["unknown", "unknown"], "a faulted dispatch is unknown, never done");
  assert.equal(state.plan.execution.status, "unknown", "an uncertain batch is not presented as completed");
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
  const reconciled = stateOf(pi).plan.execution.results.find((item) => item.id === accepted.nodeId);
  assert.equal(reconciled.status, "done");
  assert.equal(reconciled.runId, "run-late", "the late result stays bound to its original request");
  assert.equal(pi.delegation.length, 2, "an unknown outcome never triggers a second dispatch");
});

test("new Human input pauses approved dispatch until the Agent reaffirms the Goal", async () => {
  const pi = fakePi({ respondDelegation: (request) => new Promise((resolve) => setTimeout(() => resolve({
    status: "completed", runId: `run-${request.nodeId}`, model: request.model,
    result: { kind: "structured", value: { status: "done", summary: "late child", evidence: ["src/late.ts:1"], reason: "" } },
    usage: { input: 1, output: 1, cost: 0.001, turns: 1, toolCalls: 0, durationMs: 10 },
  }), 300)) });
  await plannedGoal(pi);
  await approve(pi);
  await waitFor(() => stateOf(pi).plan.execution?.status === "running", "the approved wave starts");
  await sendHuman(pi, "Actually, also keep the existing flags unchanged.");
  assert.equal(dagApprovalStatus(stateOf(pi)).approved, false, "unreviewed Human input withdraws authorization");
  const plan = await view(pi, { view: "plan" });
  assert.equal(plan.approval, "stale", "an answered-but-withdrawn approval is reported as stale");
  await assert.rejects(() => call(pi, "compass_plan", { action: "assess", taskId: "api", status: "pass", evidence: "Verified route order.", caveats: [], unresolvedCaveats: [] }), /no current correlated Human approval/);
  await waitFor(() => stateOf(pi).plan.execution?.status === "completed", "the already-started child terminal result is still consumed");
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

test("a missing structured-delegation handler fails closed without launching a child", async () => {
  const pi = fakePi({ bus: false });
  await plannedGoal(pi);
  // Approve through the module binding path: this test isolates the dispatch bridge.
  const callId = "approval-no-bus";
  const { event } = await present(pi, callId);
  const canonical = event.input.questions[0];
  // Without a bus the hook still binds; the questionnaire answer is correlated normally.
  await answer(pi, callId, canonical, { preview: canonical.options[0].preview });
  await waitFor(() => stateOf(pi).plan.execution?.status === "failed", "dispatch fails visibly");
  const state = stateOf(pi);
  assert.match(state.plan.execution.error, /No correlated invalid_request response|does not expose the structured-delegation contract/);
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
  await waitFor(() => stateOf(pi).plan.execution?.status === "running", "a wave is in flight");
  await pi.hooks.get("session_shutdown")[0]({}, ctx(pi));
  const unknown = stateOf(pi);
  assert.equal(unknown.plan.execution.status, "unknown", "an in-flight batch is never presumed stopped or restarted");
  // A restarted Pi session is a new extension instance over the same native branch.
  const restarted = fakePi({ ...slow, entries: pi.entries });
  await boot(restarted);
  await assert.rejects(() => call(restarted, "compass_plan", { action: "start", taskIds: ["api"] }), /unresolved native batch|No state changed/);
  await assert.rejects(() => call(restarted, "compass_plan", {
    action: "resolve", requestId: unknown.plan.execution.requestId, confirmedNoActiveRuns: true,
    confirmationEvidence: "short", results: unknown.plan.execution.taskIds.map((id) => ({ id, status: "done", evidence: "checked" })),
  }), /confirmationEvidence/);
  await call(restarted, "compass_plan", {
    action: "resolve", requestId: unknown.plan.execution.requestId, confirmedNoActiveRuns: true,
    confirmationEvidence: "Native subagent status shows both recorded child runs terminal.",
    results: unknown.plan.execution.taskIds.map((id) => ({ id, status: "blocked", reason: "Child run terminal without usable evidence." })),
  });
  const state = stateOf(restarted);
  assert.equal(state.plan.execution.status, "completed");
  assert.equal(state.plan.tasks.every((task) => task.status === "blocked"), true);
  assert.equal(pi.delegation.length, 2, "the unknown batch was not redispatched");
});

test("RouteSet selection is Human-owned, uses Goal criterion IDs, and never creates DAG tasks", async () => {
  const pi = fakePi();
  await boot(pi);
  await setGoal(pi, "Choose an adapter strategy", { criteria: ["Shared smoke test passes"] });
  const before = stateOf(pi);
  await assert.rejects(() => call(pi, "compass_route", { action: "define", baselineRef: "git:base", criteria: ["AC9"], routes: [{ routeId: "A", summary: "Existing adapter" }, { routeId: "B", summary: "New adapter" }] }), /current Goal criterion ID/);
  await assert.rejects(() => call(pi, "compass_route", { action: "define", baselineRef: "git:base", criteria: ["AC1"], routes: [{ routeId: "parallel_exploration", summary: "A" }, { routeId: "B", summary: "B" }] }), /reserved/);
  assert.equal(stateOf(pi).plan.tasks.length, before.plan.tasks.length, "alternatives are not DAG tasks");
  const defined = receipt(await call(pi, "compass_route", { action: "define", baselineRef: "git:base", criteria: ["AC1"], routes: [{ routeId: "A", summary: "Existing adapter" }, { routeId: "B", summary: "New adapter" }] }));
  assert.equal(defined.prompt.questions.length, 1);
  const routeView = await view(pi, { view: "route" });
  assert.equal(routeView.route.selected, undefined);
  const callId = "route-selection";
  const prompt = routeView.route.prompt;
  pi.entries.push({ id: `assistant-${callId}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "ask_user_question", arguments: prompt }] } });
  const event = { toolName: "ask_user_question", toolCallId: callId, input: structuredClone(prompt) };
  assert.equal(await pi.hooks.get("tool_call")[0](event, ctx(pi)), undefined);
  const canonical = event.input.questions[0];
  assert.deepEqual(canonical.options.map((option) => option.label), ["A", "B"]);
  const details = { answers: [{ questionIndex: 0, question: canonical.question.slice(0, 400), kind: "option", answer: "B", selected: ["B"], preview: canonical.options[1].preview }] };
  for (const handler of pi.hooks.get("tool_result") ?? []) await handler({ toolName: "ask_user_question", toolCallId: callId, isError: false, content: [{ type: "text", text: "Human answered: B" }], details }, ctx(pi));
  const selected = await view(pi, { view: "route" });
  assert.equal(selected.route.selected, "B");
  assert.equal(stateOf(pi).plan.tasks.length, 0, "route selection does not fabricate a DAG");
});

test("acceptance records only existing criteria and repeated identical evidence is a no-op", async () => {
  const pi = fakePi();
  await boot(pi);
  await setGoal(pi, "Prove the smoke path", { criteria });
  const revision = stateOf(pi).stateRevision;
  await assert.rejects(() => call(pi, "compass_acceptance", { results: [{ criterion: "AC9", status: "reported_pass", evidence: "invented" }] }), /No state changed/);
  await assert.rejects(() => call(pi, "compass_acceptance", { results: [{ criterion: "AC1", status: "reported_pass", evidence: "one" }, { criterion: "AC1", status: "failed", evidence: "two" }] }), /once per batch/);
  assert.equal(stateOf(pi).stateRevision, revision);
  await call(pi, "compass_acceptance", { results: [{ criterion: "AC1", status: "reported_pass", evidence: "Ran npm test; 12/12 passed." }] });
  const first = stateOf(pi);
  await call(pi, "compass_acceptance", { results: [{ criterion: "AC1", status: "reported_pass", evidence: "Ran npm test; 12/12 passed." }] });
  assert.equal(stateOf(pi).stateRevision, first.stateRevision, "identical retry does not inflate state");
  const status = await view(pi, { view: "acceptance" });
  assert.equal(status.status, "active");
  assert.equal(status.passed, 1);
  assert.equal(status.unverified, 1);
});

test("out-of-scope writes are advisory drift evidence, not a global lock", async () => {
  const pi = fakePi();
  await plannedGoal(pi, [tasks[0], { ...tasks[1], executor: "parent", writeScope: "src/ui" }]);
  await approve(pi);
  const event = { toolName: "edit", toolCallId: "write-1", input: { path: "docs/notes.md" } };
  const patch = await pi.hooks.get("tool_call").find(Boolean)(event, ctx(pi));
  assert.equal(patch, undefined, "Compass never blocks a write by itself");
  const state = stateOf(pi);
  assert.equal(state.trace.writes.some((item) => item.target.includes("docs/notes.md")), true);
  assert.match(state.plan.executionDrift?.reason ?? "", /no writable DAG task|writeScope|outside/);
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
  pi.entries.push({ type: "custom", customType: "pi-compass-v2.goalrun", data: { schemaVersion: 8, goal: { current: "legacy" }, plan: { tasks: [] } } });
  await assert.rejects(() => pi.hooks.get("session_tree")[0]({}, ctx(pi)), /Unsupported Compass GoalRun schema/);
  assert.equal(pi.entries.at(-1).data.schemaVersion, 8, "raw history is preserved");
});

test("failed native persistence never reports a mutation as committed", async () => {
  const pi = fakePi();
  await boot(pi);
  await sendHuman(pi, "Persist a Goal");
  const persisted = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").length;
  pi.failAppend = true;
  await assert.rejects(() => call(pi, "compass_goal", {
    action: "set", current: "Persist a Goal", constraints: [], criteria,
    sources: [humanSourceRef(pi.branch(), latestHumanSource(pi.branch()))],
  }), /persistence failed/);
  assert.equal(pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").length, persisted, "no candidate state is activated or persisted");
});

test("compass-preflight reports the fixed registry and host scope readiness", async () => {
  const pi = fakePi();
  await boot(pi);
  const notifications = [];
  const context = ctx(pi, { ui: { notify(body, level) { notifications.push({ body, level }); } } });
  await pi.commands.get("compass-preflight").handler("", context);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /PASS Release/);
  assert.match(notifications[0].body, /PASS Fixed tool registry/);
  assert.equal(notifications[0].level, "info");
});

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
