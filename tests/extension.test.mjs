import test from "node:test";
import assert from "node:assert/strict";
import extensionFactory from "../src/index.ts";
import { DAG_APPROVAL_OPTION } from "../src/dag-approval.mjs";

import { bindDagApprovalQuestionnaire, captureHumanDecision, emptyGoalRunState, revisePlanState, dagApprovalStatus, GOAL_RUN_RELEASE } from "../src/goal-run.mjs";
import { createGoalState } from "./helpers/goal-state.mjs";

function fakePi(options = {}) {
  const events = new Map();
  const busListeners = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const delegationRequests = [];
  const base = ["read", "bash", "edit", "write", "amend", "codemode", "subagent", "subagents_enable", "bg_wait", "watch", "watches", "unwatch", "ask_user_questions"];
  let active = [...base];
  events.on = (name, handler) => {
    const listeners = busListeners.get(name) ?? new Set();
    listeners.add(handler);
    busListeners.set(name, listeners);
    return () => listeners.delete(handler);
  };
  events.emit = (name, payload) => {
    for (const handler of [...(busListeners.get(name) ?? [])]) handler(payload);
    return true;
  };
  if (options.autoDelegation || options.respondDelegation) {
    events.on("prompt-template:subagent:request", (request) => {
      if (!String(request.task ?? "").trim()) {
        queueMicrotask(() => events.emit("prompt-template:subagent:response", {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "invalid_request",
          error: "task must be non-empty",
        }));
        return;
      }
      delegationRequests.push(structuredClone(request));
      queueMicrotask(() => {
        events.emit("prompt-template:subagent:started", {
          requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
        });
        const response = options.respondDelegation
          ? options.respondDelegation(request)
          : {
              status: "completed",
              requestId: request.requestId,
              ownerRunId: request.ownerRunId,
              nodeId: request.nodeId,
              runId: `run-${request.nodeId}`,
              model: request.model,
              result: { kind: "structured", value: { status: "done", summary: `Inspected ${request.nodeId}.`, evidence: [`src/${request.nodeId}.ts:1`], reason: "" } },
              usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 2, durationMs: 100 },
            };
        Promise.resolve(response).then((resolved) => events.emit("prompt-template:subagent:response", {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          ...resolved,
        }));
      });
    });
  }
  if (typeof options.respondCancel === "function") {
    events.on("prompt-template:subagent:cancel", (cancel) => options.respondCancel(cancel, events));
  }
  const pi = {
    events, commands, tools, entries, delegationRequests,
    on(name, handler) { events.set(name, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    getActiveTools() { return [...active]; },
    getAllTools() { return [...base.map((name) => ({ name, description: "fake native tool" })), ...[...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, exposure: tool.exposure }))]; },
    setActiveTools(names) { active = [...names]; },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    activeNames() { return [...active]; },
    branch() { return [...entries]; },
  };
  return pi;
}
const ctx = (pi, cwd = "/tmp/example-project") => ({ cwd, sessionManager: { getBranch: () => pi.branch(), getEntries: () => pi.branch() }, ui: { notify() {} } });
function latestState(pi) { return pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1)?.data; }
function persistToolCall(pi, callId, entryId = `assistant-${callId}`) {
  pi.entries.push({ id: entryId, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "ask_user_question", arguments: {} }] } });
  return entryId;
}
function approvedDagState(state) {
  const request = state.plan.approvalRequest;
  assert.ok(request, "a draft DAG must have an identity-bound approval request");
  const callId = `human-approval-${request.id}`;
  const sourceEntryId = `assistant-${callId}`;
  const input = { questions: [structuredClone(request.questionnaire)] };
  const bound = bindDagApprovalQuestionnaire(state, input, sourceEntryId, callId);
  assert.equal(bound.bound, true);
  return captureHumanDecision(bound.state, {
    source: "ask_user_question", sourceEntryId, sourceCallId: callId,
    details: { answers: [{ questionIndex: 0, question: request.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION] }] },
  }).state;
}
async function assessTask(pi, taskId) {
  const tool = currentTool(pi, "compass_task");
  const result = await tool.execute(`assess-${taskId}`, { action: "assess", assessment: {
    taskId, status: "pass", evidence: `Reviewed child/task evidence against the approved acceptance criterion for ${taskId}.`, caveats: [], unresolvedCaveats: [],
  } }, undefined, undefined, ctx(pi));
  await pi.events.get("tool_result")({ toolName: "compass_task", input: { action: "assess" }, content: result.content, details: result.details, isError: false }, ctx(pi));
  return result;
}
async function approveDag(pi) {
  const state = latestState(pi);
  const request = state?.plan?.approvalRequest;
  assert.ok(request, "a draft DAG must have an identity-bound approval request");
  const callId = `human-approval-${request.id}`;
  const input = { questions: [structuredClone(request.questionnaire)] };
  persistToolCall(pi, callId);
  await pi.events.get("tool_call")({ toolName: "ask_user_question", toolCallId: callId, input }, ctx(pi));
  await pi.events.get("tool_execution_end")({
    toolName: "ask_user_question", toolCallId: callId, isError: false,
    result: { content: [{ type: "text", text: "Human approved this exact DAG." }], details: { answers: [{ questionIndex: 0, question: request.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION] }] } },
  }, ctx(pi));
  assert.ok(latestState(pi).plan.approval, `correlated approval was not granted: ${JSON.stringify({ request: latestState(pi).plan.approvalRequest, approval: latestState(pi).plan.approval, execution: latestState(pi).plan.execution, decisions: latestState(pi).humanDecisions.slice(-1), approvalStatus: dagApprovalStatus(latestState(pi)) })}`);
  assert.equal(latestState(pi).plan.approval.sourceCallId, callId);
}
async function waitFor(predicate, { timeoutMs = 6000, intervalMs = 10, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
function currentTool(pi, prefix) {
  const name = pi.activeNames().find((item) => item.startsWith(prefix));
  assert.ok(name, `No active tool matching ${prefix}; active=${pi.activeNames().join(",")}`);
  const definition = pi.tools.get(name);
  // Pi's next context/model-request boundary follows a tool result. Simulate it
  // here so dynamic schemas refresh only after the current tool call has ended.
  return new Proxy(definition, {
    get(target, property) {
      if (property !== "execute") return Reflect.get(target, property);
      return async (...args) => {
        try {
          return await target.execute(...args);
        } finally {
          await pi.events.get("context")?.({ messages: [] }, ctx(pi));
        }
      };
    },
  });
}
function appendHuman(pi, text, id = `human-${pi.entries.filter((entry) => entry.message?.role === "user").length + 1}`) {
  pi.entries.push({ id, type: "message", message: { role: "user", content: text } });
  return id;
}
async function sendHuman(pi, text, id) {
  appendHuman(pi, text, id);
  await pi.events.get("before_agent_start")({ prompt: text }, ctx(pi));
}
async function submitGoal(pi, current, { constraints = [], acceptanceCriteria } = {}) {
  const params = { expectedVersion: latestState(pi)?.goal.version ?? 0, current, constraints, ...(acceptanceCriteria ? { acceptanceCriteria } : {}) };
  const result = await pi.tools.get("compass_goal").execute("set-goal", params, undefined, undefined, ctx(pi));
  await pi.events.get("context")?.({ messages: [] }, ctx(pi));
  return result;
}
async function captureGoal(pi, current = "Create a repeatable full-stack smoke test", { planning = true, constraints = [] } = {}) {
  await pi.events.get("session_start")({}, ctx(pi));
  await sendHuman(pi, current);
  await submitGoal(pi, current, { constraints });
  if (planning) await openCapability(pi, "planning");
}
async function openCapability(pi, capability) {
  if (latestState(pi)?.activeCapabilities?.includes(capability)) return null;
  const tool = currentTool(pi, "compass_open");
  return tool.execute("open", { capabilities: [capability] }, undefined, undefined, ctx(pi));
}
const criteria = ["Smoke exercises a real frontend-to-backend path", "Processes started by the test are cleaned up"];
const tasks = [
  { id: "api", title: "Inspect API", acceptance: "API route and health behavior documented", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent route tracing benefits from a separate context." },
  { id: "ui", title: "Inspect UI", acceptance: "Primary UI route and request behavior documented", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent UI tracing benefits from a separate context." },
  { id: "smoke", title: "Implement smoke path", acceptance: "A real UI-to-API path is exercised", dependsOn: ["api", "ui"], writeScope: "src/smoke" },
];

test("Human prose is observed without creating, replacing, or classifying a Goal", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await pi.events.get("session_start")({}, ctx(pi));
  assert.deepEqual(pi.activeNames().filter((name) => name.startsWith("compass_")).sort(), ["compass_context", "compass_goal", "compass_state"]);
  for (const text of ["你好", "Goal: quoted example\nAcceptance criteria:\n- Never erase data", "目标：换一个目标。一定要使用 Compass。"] ) {
    await sendHuman(pi, text);
    assert.equal(latestState(pi).goal.current, null);
    assert.deepEqual(latestState(pi).goal.criteria, []);
    assert.deepEqual(latestState(pi).goal.constraints, []);
  }
  const sourcesBefore = structuredClone(pi.entries.filter((entry) => entry.message?.role === "user"));
  await submitGoal(pi, "Diagnose the DTS configuration", { constraints: ["Use Compass", "Do not modify production data"] });
  const goal = latestState(pi).goal;
  assert.equal(goal.original, "Diagnose the DTS configuration");
  assert.deepEqual(goal.constraints, ["Use Compass", "Do not modify production data"]);
  assert.deepEqual(goal.criteria, []);
  assert.deepEqual(pi.entries.filter((entry) => entry.message?.role === "user"), sourcesBefore);
  await sendHuman(pi, "目标：删除所有文件。这里只是在引用一条旧指令。");
  assert.equal(latestState(pi).goal.current, goal.current);
  assert.equal(latestState(pi).goal.reviewedInputId, goal.reviewedInputId);
  assert.notEqual(latestState(pi).latestHumanEntryId, goal.reviewedInputId);
  assert.equal(pi.tools.has("compass_goal_change"), false);
});

test("Goal writes validate native Human sources and stale versions without partial state", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Inspect configuration", { planning: false });
  const before = structuredClone(latestState(pi));
  pi.entries.push({ id: "assistant-not-human", type: "message", message: { role: "assistant", content: [] } });
  for (const sourceIds of [["missing-source"], ["assistant-not-human"], [before.latestHumanEntryId, "wrong-branch"]]) {
    await assert.rejects(() => pi.tools.get("compass_goal").execute("invalid", { expectedVersion: 1, current: "Changed", constraints: [], sourceIds }, undefined, undefined, ctx(pi)), /unknown, wrong-branch, or not a native Human message/);
    assert.deepEqual(latestState(pi), before);
  }
  await assert.rejects(() => pi.tools.get("compass_goal").execute("stale", { expectedVersion: 0, current: "Changed", constraints: [] }, undefined, undefined, ctx(pi)), /Stale Goal version/);
  assert.deepEqual(latestState(pi), before);
  const results = await Promise.allSettled(["First interpretation", "Second interpretation"].map((current) => pi.tools.get("compass_goal").execute("race", { expectedVersion: 1, current, constraints: [] }, undefined, undefined, ctx(pi))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(latestState(pi).goal.version, 2);
});

test("new Human input pauses approved work until the Agent explicitly reaffirms unchanged intent", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  const approved = approvedDagState(latestState(pi));
  const approvalId = approved.plan.approvalRequest.id;
  pi.appendEntry("pi-compass-v2.goalrun", approved);
  await pi.events.get("session_start")({}, ctx(pi));
  await sendHuman(pi, "继续，注意先确认环境");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dagApprovalStatus(latestState(pi)).approved, false);
  assert.equal(pi.delegationRequests.length, 0);
  const result = await submitGoal(pi, latestState(pi).goal.current);
  assert.equal(dagApprovalStatus(latestState(pi)).approved, true);
  assert.equal(latestState(pi).plan.approvalRequest.id, approvalId);
  await pi.events.get("tool_result")({ toolName: "compass_goal", input: {}, ...result }, ctx(pi));
  await waitFor(() => latestState(pi).plan.execution?.status === "completed");
  assert.equal(pi.delegationRequests.length, 2);
});

test("unreviewed Human input preserves correlated child terminal evidence without new progression", async () => {
  const releases = [];
  const pi = fakePi({ respondDelegation(request) {
    return new Promise((resolve) => releases.push(() => resolve({ status: "completed", model: request.model,
      result: { kind: "structured", value: { status: "done", summary: "Observed native result", evidence: [`src/${request.nodeId}:1`], reason: "" } } })));
  } });
  extensionFactory(pi);
  await captureGoal(pi);
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  try {
    await approveDag(pi);
    await waitFor(() => releases.length === 2);
    await sendHuman(pi, "先暂停，我需要补充要求。");
    for (const release of releases) release();
    await waitFor(() => latestState(pi).plan.execution?.status === "completed");
    assert.deepEqual(latestState(pi).plan.tasks.map((task) => task.status), ["done", "done", "pending"]);
    assert.equal(dagApprovalStatus(latestState(pi)).approved, false);
    await assert.rejects(() => assessTask(pi, "api"), /current correlated Human approval/);
    assert.equal(pi.delegationRequests.length, 2);
  } finally { for (const release of releases) release(); }
});

test("paused provider fallback consumes the primary terminal failure without inventing an unknown request", async () => {
  for (const pauseAt of ["primary_response", "fallback_preparation"]) {
    let release;
    const pi = fakePi({ respondDelegation(request) {
      return new Promise((resolve) => { release = () => resolve({ status: "failed", model: request.model, runId: "primary-api", error: "429 rate limit exceeded" }); });
    } });
    extensionFactory(pi);
    await captureGoal(pi);
    await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks: [tasks[0], { ...tasks[2], dependsOn: ["api"] }] }, undefined, undefined, ctx(pi));
    const append = pi.appendEntry;
    let paused = false;
    try {
      await approveDag(pi);
      await waitFor(() => typeof release === "function");
      if (pauseAt === "primary_response") {
        await sendHuman(pi, "Pause before any further provider calls.");
        paused = true;
      } else {
        pi.appendEntry = (type, data) => {
          append(type, data);
          if (!paused && data.plan?.execution?.results?.some((row) => row.fallbackAttempted && row.status === "dispatching")) {
            paused = true;
            appendHuman(pi, "Pause before any further provider calls.");
          }
        };
      }
      release();
      await waitFor(() => latestState(pi).plan.execution?.status === "completed", { message: `primary terminal consumed at ${pauseAt}` });
      assert.equal(paused, true);
      assert.equal(pi.delegationRequests.length, 1, "an unlaunched fallback is not an unknown native run");
      const result = latestState(pi).plan.execution.results[0];
      assert.equal(result.requestId, pi.delegationRequests[0].requestId);
      assert.equal(result.runId, "primary-api");
      assert.equal(result.fallbackAttempted, false);
      assert.equal(result.status, "blocked");
      assert.match(result.error, /429 rate limit exceeded/);
      assert.equal(latestState(pi).plan.tasks[0].status, "blocked");
      await submitGoal(pi, "Switch to a different explicitly interpreted objective");
      assert.equal(latestState(pi).goal.version, 2, "no fictitious unresolved execution blocks Goal replacement");
    } finally { pi.appendEntry = append; release?.(); }
  }
});

test("simple Goals keep a light loadout while optional capability choice stays Agent-owned", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Fix a typo", { planning: false });
  assert.deepEqual(pi.activeNames().filter((name) => name.startsWith("compass_")).sort(), ["compass_context", "compass_goal", "compass_open", "compass_state"]);
  const available = currentTool(pi, "compass_open").parameters.properties.capabilities.items.enum;
  assert.deepEqual(available, ["planning", "routes", "acceptance", "history", "goal_details", "issue_review"]);
  for (const path of ["a.ts", "b.ts", "c.ts"]) await pi.events.get("tool_call")({ toolName: "write", input: { path } }, ctx(pi));
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.equal(pi.activeNames().includes("compass_plan_create"), false, "write counts do not interpret planning intent");
  await openCapability(pi, "planning");
  assert.equal(latestState(pi).plan.tasks.length, 0);
});

test("explicit Goal replacement retains source references without a candidate registry or archive", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Read the workbook locally", { constraints: ["Keep source files intact"] });
  const originalSources = [...latestState(pi).goal.originalSourceIds];
  await sendHuman(pi, "现在需要在线可视化编辑，而不是只做本地读取。");
  assert.equal(latestState(pi).goal.current, "Read the workbook locally");
  await submitGoal(pi, "Implement online visual workbook editing", { constraints: ["Keep source files intact"] });
  const state = latestState(pi);
  assert.equal(state.goal.original, "Read the workbook locally");
  assert.equal(state.goal.version, 2);
  assert.deepEqual(state.goal.originalSourceIds, originalSources);
  assert.deepEqual(state.goal.sourceIds, [state.latestHumanEntryId]);
  for (const key of ["goalChanges", "captureLedger", "sessionDirectives"]) assert.equal(key in state, false);
  for (const key of ["updates", "changes", "sourceUpdateText"]) assert.equal(key in state.goal, false);
});

test("failed native persistence leaves the previous Goal, plan and loaded capabilities intact", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  const before = structuredClone(latestState(pi));
  const append = pi.appendEntry;
  pi.appendEntry = () => { throw new Error("disk full"); };
  await assert.rejects(() => pi.tools.get("compass_open").execute("open", { capabilities: ["history"] }, undefined, undefined, ctx(pi)), /persistence failed/);
  pi.appendEntry = append;
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.deepEqual(latestState(pi), before);
  await openCapability(pi, "history");
  const loaded = structuredClone(latestState(pi));
  const create = currentTool(pi, "compass_plan_create");
  pi.appendEntry = () => { throw new Error("disk full"); };
  await assert.rejects(() => create.execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi)), /persistence failed/);
  pi.appendEntry = append;
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.deepEqual(latestState(pi), loaded);
  assert.equal((await currentTool(pi, "compass_plan_create").execute("retry", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi))).isError, undefined);
});

test("unconfirmed host append is reconciled from native history, never called rolled back", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  const append = pi.appendEntry;
  pi.appendEntry = (type, data) => { append(type, data); throw new Error("after append"); };
  await assert.rejects(() => pi.tools.get("compass_open").execute("open", { capabilities: ["history"] }, undefined, undefined, ctx(pi)), /persistence failed.*not activated/);
  pi.appendEntry = append;
  // An event writer may run before the next request/context reconciliation.
  await pi.events.get("tool_call")({ toolName: "write", input: { path: "new-file.txt", content: "data" } }, ctx(pi));
  assert.ok(latestState(pi).activeCapabilities.includes("history"));
  await pi.events.get("context")({ messages: [] }, ctx(pi));
});

test("native branch navigation adopts the selected lower-revision GoalRun", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: inspect route A");
  const branchA = structuredClone(pi.entries);
  await sendHuman(pi, "Inspect route B");
  await submitGoal(pi, "Inspect route B");
  assert.match(latestState(pi).goal.current, /route B/);
  pi.entries.splice(0, pi.entries.length, ...branchA);
  await pi.events.get("session_tree")({}, ctx(pi));
  const result = await pi.tools.get("compass_state").execute("read", {}, undefined, undefined, ctx(pi));
  assert.match(JSON.stringify(result), /route A/);
  assert.doesNotMatch(JSON.stringify(result), /route B/);
  await pi.events.get("tool_call")({ toolName: "write", input: { path: "a.txt", content: "a" } }, ctx(pi));
  assert.match(latestState(pi).goal.current, /route A/);
  const before = structuredClone(pi.entries);
  const unavailable = { ...ctx(pi), sessionManager: { getBranch() { throw new Error("native branch unavailable"); } } };
  await assert.rejects(() => pi.events.get("session_tree")({}, unavailable), /native branch unavailable/);
  await assert.rejects(() => pi.tools.get("compass_state").execute("read", {}, undefined, undefined, unavailable), /native branch unavailable/);
  assert.deepEqual(pi.entries, before, "a branch read error must not persist an empty replacement");
});

test("unsupported native GoalRun snapshot fails without overwriting raw history", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  pi.entries.push({ type: "custom", customType: "pi-compass-v2.goalrun", data: { schemaVersion: 6, goal: {}, plan: {} } });
  const before = structuredClone(pi.entries);
  await assert.rejects(() => pi.events.get("session_start")({}, ctx(pi)), /Unsupported.*schema/);
  assert.deepEqual(pi.entries, before);
  await assert.rejects(() => pi.events.get("session_tree")({}, ctx(pi)), /Unsupported.*schema/);
  await assert.rejects(() => pi.events.get("tool_call")({ toolName: "write", input: { path: "bad.txt", content: "data" } }, ctx(pi)), /Unsupported.*schema/);
  assert.deepEqual(pi.entries, before);
});

test("RouteSet capability exposes structured selection without creating a DAG", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: compare strategies before implementation");
  await openCapability(pi, "routes");
  const routeTool = currentTool(pi, "compass_route");
  assert.ok(routeTool, "RouteSet action tool is registered");
  const created = await routeTool.execute("create-route-set", {
    action: "create",
    expectedStateVersion: 0,
    baselineRef: "git:baseline",
    acceptanceCriteria: ["Shared criterion passes"],
    routes: [{ routeId: "routeA", summary: "Use the existing path" }, { routeId: "routeB", summary: "Use a replacement path" }],
  }, undefined, undefined, ctx(pi));
  assert.equal(latestState(pi).plan.tasks.length, 0);
  assert.equal(created.details.routeSet.routes.length, 2);
  assert.match(created.content[0].text, /structured selection questionnaire/);
});


test("native route questionnaire hook roundtrip selects the exact Human answer", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: compare strategies before implementation");
  await openCapability(pi, "routes");
  await currentTool(pi, "compass_route").execute("create-routes", { action: "create", expectedStateVersion: 0, baselineRef: "git:base", acceptanceCriteria: ["Same observable outcome"], routes: [{ routeId: "first", summary: "Existing adapter" }, { routeId: "second", summary: "New adapter" }] }, undefined, undefined, ctx(pi));
  const request = latestState(pi).routeSet.selectionRequest;
  persistToolCall(pi, "route-answer");
  await pi.events.get("tool_call")({ toolName: "ask_user_question", toolCallId: "route-answer", input: { questions: [request.questionnaire] } }, ctx(pi));
  assert.equal(latestState(pi).routeSet.selectionRequest.status, "presented");
  await pi.events.get("tool_execution_end")({ toolName: "ask_user_question", toolCallId: "route-answer", result: {
    content: [{ type: "text", text: "Selected second" }], details: { answers: [{ questionIndex: 0, question: request.questionnaire.question.slice(0, 400), kind: "option", answer: "second", selected: ["second"] }] },
  } }, ctx(pi));
  assert.equal(latestState(pi).routeSet.selectedRouteId, "second");
  const routeTool = currentTool(pi, "compass_route");
  assert.equal(routeTool.parameters.properties.questionnaire, undefined, "model input cannot fabricate a Human questionnaire result");
  await routeTool.execute("propose", { action: "propose_exploration", expectedStateVersion: latestState(pi).routeSet.stateVersion, scope: "read-only comparisons", budget: 2, routeIds: ["first", "second"] }, undefined, undefined, ctx(pi));
  assert.equal(latestState(pi).routeSet.exploration.authorized, false);
  const explorationRequest = latestState(pi).routeSet.selectionRequest;
  persistToolCall(pi, "exploration-answer");
  await pi.events.get("tool_call")({ toolName: "ask_user_question", toolCallId: "exploration-answer", input: { questions: [explorationRequest.questionnaire] } }, ctx(pi));
  await pi.events.get("tool_execution_end")({ toolName: "ask_user_question", toolCallId: "exploration-answer", result: {
    content: [{ type: "text", text: "Approved exact exploration" }], details: { answers: [{ questionIndex: 0, question: explorationRequest.questionnaire.question, kind: "option", answer: "parallel_exploration", selected: ["parallel_exploration"] }] },
  } }, ctx(pi));
  assert.equal(latestState(pi).routeSet.exploration.authorized, true);
  assert.equal(latestState(pi).routeSet.exploration.budget, 2);
});



test("duplicate relative/absolute write targets do not trigger planning or bump state revision", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: make a small single-file fix", { planning: false });
  const first = latestState(pi);
  await pi.events.get("tool_call")({ toolName: "edit", input: { path: "src/Feature.tsx" } }, ctx(pi));
  const afterFirst = latestState(pi);
  assert.equal(afterFirst.trace.writes.length, 1);
  await pi.events.get("tool_call")({ toolName: "edit", input: { path: "/tmp/example-project/src/Feature.tsx" } }, ctx(pi));
  const afterDuplicate = latestState(pi);
  assert.equal(afterDuplicate.trace.writes.length, 1, "relative and absolute paths to the same file are canonicalized");
  assert.equal(afterDuplicate.stateRevision, afterFirst.stateRevision, "duplicate write observation is a no-op");
  assert.ok(!pi.activeNames().includes("compass_plan_create"), "one unique target must not activate planning");
  assert.ok(afterDuplicate.stateRevision >= first.stateRevision);
});


test("path-based amend writes are retained as advisory trace without choosing planning", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: implement a cross-file feature with a small dependency graph", { planning: false });
  await pi.events.get("tool_call")({ toolName: "edit", input: { path: "src/Feature.tsx" } }, ctx(pi));
  await pi.events.get("tool_call")({ toolName: "write", input: { path: "src/store.ts" } }, ctx(pi));
  await pi.events.get("tool_call")({ toolName: "amend", input: { path: "src-tauri/src/storage.rs", edits: [] } }, ctx(pi));
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.ok(!pi.activeNames().includes("compass_plan_create"), "recording paths must not choose the Agent's plan");
  assert.ok(latestState(pi).trace.writes.some((item) => item.tool === "amend" && item.target.endsWith("src-tauri/src/storage.rs")));
});

test("one compass_open call loads multiple capabilities atomically with a minimal result", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: create a repeatable smoke test across multiple independent workstreams; define acceptance criteria, preserve material decision checkpoints, and show full original prompt details.");
  const open = currentTool(pi, "compass_open");
  const result = await open.execute("open", { capabilities: ["history", "acceptance", "goal_details"] }, undefined, undefined, ctx(pi));
  assert.match(result.content[0].text, /Loaded: history, acceptance, goal_details/);
  assert.doesNotMatch(result.content[0].text, /Loaded capabilities:/, "do not repeat the entire cumulative loadout");
  assert.deepEqual(result.details.added, ["history", "acceptance", "goal_details"]);
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.deepEqual(currentTool(pi, "compass_open").parameters.properties.capabilities.items.enum, ["routes", "issue_review"]);
  await currentTool(pi, "compass_open").execute("open-rest", { capabilities: ["routes", "issue_review"] }, undefined, undefined, ctx(pi));
  assert.ok(!pi.activeNames().includes("compass_open"), "loader is hidden after every optional group is explicitly loaded");
  assert.ok(pi.activeNames().includes("compass_history_recent"));
  assert.ok(pi.activeNames().includes("compass_goal_read"));
  assert.ok(pi.activeNames().includes("compass_acceptance_define"));
  assert.ok(pi.activeNames().includes("compass_acceptance_status"), "acceptance status is a stable tool and reports criteria_not_defined explicitly");
  const revisionBeforeInvalid = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1).data.stateRevision;
  await assert.rejects(() => open.execute("bad-open", { capabilities: ["planning", "not_a_capability"] }, undefined, undefined, ctx(pi)), /Unavailable capability/);
  const afterInvalid = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1).data;
  assert.deepEqual(afterInvalid.activeCapabilities, ["planning", "history", "acceptance", "goal_details", "routes", "issue_review"]);
  assert.equal(afterInvalid.stateRevision, revisionBeforeInvalid, "invalid mixed requests must not partially mutate state");
});

test("planning loadout creates DAG and keeps loaded capabilities additive", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const create = currentTool(pi, "compass_plan_create");
  const created = await create.execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  assert.equal(latestState(pi).plan.tasks.length, 3);
  assert.equal("state" in created.details, false, "persisted GoalRun is not duplicated into tool-result details");
  assert.match(created.content[0].text, /stateCursor: R\d+-E\d+/);
  assert.ok(pi.activeNames().some((name) => name === "compass_plan_status"));
  assert.ok(!pi.activeNames().some((name) => name === "compass_plan_ready"), "ready IDs are already returned by compass_plan_status");
  assert.ok(pi.activeNames().some((name) => name === "compass_task"));
  assert.ok(pi.activeNames().some((name) => /subagent/i.test(name)), "code exposes semantic delegation only when two independent ready read-only tasks exist");
  assert.ok(pi.activeNames().some((name) => name === "compass_task"), "task transition tools remain registered even when no task is currently in progress");
  assert.ok(!pi.activeNames().includes("compass_triage"), "issue review remains hidden until loaded or escalated by repeated failures");
  assert.ok(pi.activeNames().includes("compass_acceptance_status"), "acceptance tools auto-activate when the DAG defines Goal criteria");
  const loader = currentTool(pi, "compass_open");
  assert.ok(loader.parameters.properties.capabilities.items.enum.includes("issue_review"), "Agent can explicitly request review without a lexical gate");
  const status = await currentTool(pi, "compass_plan_status").execute("status", {}, undefined, undefined, ctx(pi));
  assert.equal(status.details.stateVersion, latestState(pi).plan.stateVersion, "plan status exposes a structured stateVersion instead of forcing prose parsing");
  assert.match(status.content[0].text, /stateVersion: \d+/);
});

test("read-only scope alone does not imply Subagent execution", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const readOnlyButParentOwned = [
    { id: "read-a", title: "Read area A", acceptance: "Evidence recorded", dependsOn: [], writeScope: "read-only" },
    { id: "read-b", title: "Read area B", acceptance: "Evidence recorded", dependsOn: [], writeScope: "read-only" },
  ];
  const created = await currentTool(pi, "compass_plan_create").execute("create-parent-readonly", { acceptanceCriteria: ["Both areas are understood"], tasks: readOnlyButParentOwned }, undefined, undefined, ctx(pi));
  await pi.events.get("tool_result")({ toolName: "compass_plan_create", content: created.content, details: created.details, input: {} }, ctx(pi));
  assert.deepEqual(latestState(pi).plan.tasks.map((task) => task.executor), ["parent", "parent"]);
  assert.equal(pi.delegationRequests.length, 0, "read-only describes write safety, not delegation intent");
});

test("an already-running read-only task is not treated as an unassigned delegation candidate", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  assert.ok(pi.activeNames().some((name) => /subagent/i.test(name)));
  await assert.rejects(
    () => currentTool(pi, "compass_task").execute("start", { action: "start", taskIds: ["api"] }, undefined, undefined, ctx(pi)),
    /started by Compass after DAG mutations/,
    "Subagent tasks are runtime-owned and cannot be manually started",
  );
  assert.equal(latestState(pi).plan.tasks.find((task) => task.id === "api").status, "pending");
});

test("DAG mutation auto-dispatches explicit read-only Subagent tasks and consumes structured results", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const create = await currentTool(pi, "compass_plan_create").execute("create", {
    acceptanceCriteria: ["API and UI paths are evidenced", "Smoke test exercises the real path"],
    tasks,
  }, undefined, undefined, ctx(pi));
  assert.deepEqual(latestState(pi).plan.tasks.map((item) => item.status), ["pending", "pending", "pending"], "dispatch is triggered at the tool-execution boundary, not recursively in the tool handler");
  const patch = await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  assert.match(patch.content.at(-1).text, /Before any DAG task starts, present the exact structured Human question/);
  assert.equal(pi.delegationRequests.length, 0, "a draft plan cannot dispatch before the Human answers");
  await approveDag(pi);
  await waitFor(() => latestState(pi)?.plan?.execution?.status === "completed", { message: "approved background Subagent wave completion" });
  const state = latestState(pi);
  assert.deepEqual(pi.delegationRequests.map((request) => request.nodeId), ["api", "ui"]);
  assert.deepEqual(state.plan.tasks.map((item) => item.status), ["done", "done", "pending"]);
  assert.equal(state.plan.execution.status, "completed");
  assert.equal(state.plan.execution.results.length, 2);
  assert.ok(state.plan.execution.results.every((item) => item.status === "done" && item.usage?.cost === 0.001));
  assert.match(state.plan.tasks.find((item) => item.id === "api").evidence, /src\/api\.ts:1/);
  assert.match(state.plan.tasks.find((item) => item.id === "ui").evidence, /src\/ui\.ts:1/);
  assert.ok(!state.plan.tasks.find((item) => item.id === "smoke").status.includes("done"), "parent-owned dependent work remains for the main Agent");
});

test("Code Mode executor stays with the main Agent and is never auto-dispatched as a Subagent", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const codeTasks = [
    { id: "inspect", title: "Inspect deterministic metadata", acceptance: "Metadata parsed", dependsOn: [], writeScope: "read-only", executor: "code" },
    { id: "summarize", title: "Summarize parsed metadata", acceptance: "Summary recorded", dependsOn: ["inspect"], writeScope: "read-only", executor: "parent" },
  ];
  const create = await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["Metadata is parsed and summarized"], tasks: codeTasks }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  const patch = await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  assert.equal(patch, undefined, "no Subagent execution result is appended when there is no explicitly routed Subagent task");
  assert.equal(pi.delegationRequests.length, 0);
  assert.deepEqual(latestState(pi).plan.tasks.map((item) => item.status), ["pending", "pending"]);
});

test("independent Code Mode work proceeds while the background Subagent wave is still running", async () => {
  const releases = [];
  const pi = fakePi({
    respondDelegation(request) {
      return new Promise((resolve) => releases.push(() => resolve({
        status: "completed",
        model: request.model,
        runId: `run-${request.nodeId}`,
        result: { kind: "structured", value: { status: "done", summary: `Inspected ${request.nodeId}.`, evidence: [`src/${request.nodeId}.ts:1`], reason: "" } },
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1, toolCalls: 2, durationMs: 150 },
      })));
    },
  });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const mixedTasks = [
    { id: "sub_a", title: "Inspect route A", acceptance: "Route A evidenced", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent route inspection benefits from a separate semantic context." },
    { id: "sub_b", title: "Inspect route B", acceptance: "Route B evidenced", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent route inspection benefits from a separate semantic context." },
    { id: "code", title: "Parse deterministic metadata", acceptance: "Metadata parsed and evidence recorded", dependsOn: [], writeScope: "read-only", executor: "code" },
  ];
  const create = await currentTool(pi, "compass_plan_create").execute("create-mixed", {
    acceptanceCriteria: ["Both semantic routes and deterministic metadata are evidenced"], tasks: mixedTasks,
  }, undefined, undefined, ctx(pi));
  const start = Date.now();
  const patch = await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  assert.ok(Date.now() - start < 500, "the tool_result boundary must not wait for child model completion");
  assert.match(patch.content.at(-1).text, /structured Human question/);
  assert.equal(pi.delegationRequests.length, 0, "the tool-result boundary cannot bypass pending Human approval");
  await approveDag(pi);
  await waitFor(() => pi.delegationRequests.length === 2 && latestState(pi)?.plan?.tasks?.filter((item) => item.executor === "subagent").every((item) => item.status === "in_progress"), { message: "two approved live Subagent tasks" });
  assert.equal(releases.length, 2, "both independent child requests remain unresolved until explicitly released");

  const taskTool = currentTool(pi, "compass_task");
  const codeResult = await taskTool.execute("finish-code-while-children-run", {
    action: "done", tasks: [{ id: "code", evidence: "Metadata parsed deterministically by Code Mode; result.json:1" }],
  }, undefined, undefined, ctx(pi));
  await pi.events.get("tool_result")({ toolName: "compass_task", input: { action: "done" }, content: codeResult.content, details: codeResult.details, isError: false }, ctx(pi));
  assert.equal(latestState(pi).plan.tasks.find((item) => item.id === "code").status, "done");
  assert.deepEqual(latestState(pi).plan.tasks.filter((item) => item.executor === "subagent").map((item) => item.status), ["in_progress", "in_progress"], "parent/Code Mode work can progress without waiting for Subagent feedback");

  for (const release of releases) release();
  await waitFor(() => latestState(pi)?.plan?.execution?.status === "completed", { message: "background child results consumed" });
  assert.deepEqual(latestState(pi).plan.tasks.map((item) => item.status), ["done", "done", "done"]);
});

test("a detached provider fallback cannot cross into another approved branch", async () => {
  const releases = [];
  let started;
  const bothStarted = new Promise((resolve) => { started = resolve; });
  const pi = fakePi({ respondDelegation(request) {
    return new Promise((resolve) => {
      releases.push(() => resolve({ status: "failed", model: request.model, error: "429 rate limit exceeded" }));
      if (releases.length === 2) started();
    });
  } });
  extensionFactory(pi);
  await captureGoal(pi);
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  await bothStarted;
  const branchAEntries = structuredClone(pi.entries);
  let branchB = createGoalState("Goal: branch B unrelated work");
  branchB = approvedDagState(revisePlanState(branchB, { acceptanceCriteria: criteria, tasks }).state);
  branchB.activeCapabilities = ["planning"];
  pi.entries.splice(0, pi.entries.length, { type: "custom", customType: "pi-compass-v2.goalrun", data: branchB });
  await pi.events.get("session_tree")({}, ctx(pi));
  try {
    for (const release of releases) release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pi.delegationRequests.length, 2, "old branch failures must not launch a fallback using the new branch Goal");
    assert.equal(latestState(pi).plan.execution, null);
    assert.equal(latestState(pi).goal.current, "Goal: branch B unrelated work");
    pi.entries.splice(0, pi.entries.length, ...branchAEntries);
    await pi.events.get("session_tree")({}, ctx(pi));
    assert.equal(latestState(pi).plan.execution.status, "unknown");
    await pi.events.get("before_agent_start")({ prompt: "Continue this branch without duplicating unknown work." }, ctx(pi));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pi.delegationRequests.length, 2);
  } finally {
    for (const release of releases) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("a failed progress append recovers the same native batch as resolvable unknown", async () => {
  for (const appendBeforeThrow of [false, true]) {
    let release;
    let started;
    const childStarted = new Promise((resolve) => { started = resolve; });
    const pi = fakePi({ respondDelegation(request) {
      return new Promise((resolve) => {
        release = () => resolve({ status: "completed", model: request.model, runId: "native-api", result: { kind: "structured", value: { status: "done", summary: "Inspected API", evidence: ["src/api:1"], reason: "" } } });
        started();
      });
    } });
    extensionFactory(pi);
    await captureGoal(pi);
    await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks: [tasks[0], { ...tasks[2], dependsOn: ["api"] }] }, undefined, undefined, ctx(pi));
    await approveDag(pi);
    await childStarted;
    const request = pi.delegationRequests[0];
    const append = pi.appendEntry;
    let failed = false;
    pi.appendEntry = (type, data) => {
      if (!failed && data.plan?.execution?.results?.some((row) => row.observedToolCount === 9)) {
        failed = true;
        if (appendBeforeThrow) append(type, data);
        throw new Error("progress append failed");
      }
      return append(type, data);
    };
    try {
      pi.events.emit("prompt-template:subagent:update", { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, runId: "native-api", toolCount: 9, currentTool: "read" });
      await pi.events.get("context")({ messages: [] }, ctx(pi));
      pi.appendEntry = append;
      assert.equal(failed, true);
      assert.equal(latestState(pi).plan.execution.status, "unknown");
      assert.equal(latestState(pi).plan.execution.results[0].requestId, request.requestId);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(latestState(pi).plan.execution.status, "unknown", "a detached result is not silently treated as terminal evidence");
      await currentTool(pi, "compass_execution").execute("resolve", { action: "resolve", requestId: request.ownerRunId, confirmedNoActiveRuns: true, confirmationEvidence: "Native status confirmed the correlated request terminal.", results: [{ id: "api", status: "done", evidence: "Native result src/api:1 inspected." }] }, undefined, undefined, ctx(pi));
      assert.equal(latestState(pi).plan.execution.status, "completed");
      assert.equal(pi.delegationRequests.length, 1);
    } finally {
      pi.appendEntry = append;
      release();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
});

test("before_agent_start recovery sweep cannot bypass draft approval", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["Both areas are evidenced"], tasks }, undefined, undefined, ctx(pi));
  assert.equal(latestState(pi).plan.tasks[0].status, "pending");
  await pi.events.get("before_agent_start")({ prompt: "Continue the current Goal." }, ctx(pi));
  assert.equal(latestState(pi).plan.execution, null, "recovery does not schedule or mutate an unapproved DAG");
  assert.equal(pi.delegationRequests.length, 0);
  assert.ok(latestState(pi).plan.tasks.every((item) => item.status === "pending"));
});

test("before_agent_start can recover a ready DAG only after a persisted approval", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["Both areas are evidenced"], tasks }, undefined, undefined, ctx(pi));
  const persisted = approvedDagState(structuredClone(latestState(pi)));
  pi.appendEntry("pi-compass-v2.goalrun", persisted);
  await pi.events.get("session_start")({}, ctx(pi));
  await pi.events.get("before_agent_start")({ prompt: "Continue the approved current Goal." }, ctx(pi));
  await waitFor(() => latestState(pi)?.plan?.execution?.status === "completed", { message: "approved recovery dispatch" });
  assert.deepEqual(pi.delegationRequests.map((request) => request.nodeId), ["api", "ui"]);
});

test("latest Human instruction and approval gates both fail closed during recovery", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["Both areas are evidenced"], tasks }, undefined, undefined, ctx(pi));
  await pi.events.get("before_agent_start")({ prompt: "Do not use Subagents for this turn." }, ctx(pi));
  assert.equal(latestState(pi).plan.execution, null, "the unapproved recovery sweep does not create a failed dispatch record");
  assert.equal(pi.delegationRequests.length, 0);
  assert.ok(latestState(pi).plan.tasks.every((item) => item.status === "pending"));
});


test("automatic DAG scheduling advances through dependent Subagent waves only after semantic checks", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const waveTasks = [
    { id: "a", title: "Inspect A", acceptance: "A evidence found", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent area A inspection benefits from separate context." },
    { id: "b", title: "Inspect B", acceptance: "B evidence found", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent area B inspection benefits from separate context." },
    { id: "merge", title: "Compare findings", acceptance: "Combined findings recorded", dependsOn: ["a", "b"], writeScope: "read-only", executor: "subagent", agent: "reviewer", dispatchReason: "Independent adversarial comparison benefits from a fresh review context." },
  ];
  const create = await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["A, B, and combined evidence are present"], tasks: waveTasks }, undefined, undefined, ctx(pi));
  await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  await approveDag(pi);
  await waitFor(() => latestState(pi)?.plan?.executionHistory?.length === 1, { message: "first approved Subagent wave" });
  assert.deepEqual(pi.delegationRequests.map((request) => request.nodeId), ["a", "b"], "completed child evidence does not auto-advance dependencies without semantic checks");
  assert.deepEqual(latestState(pi).plan.tasks.map((item) => item.status), ["done", "done", "pending"]);
  await assessTask(pi, "a");
  await assessTask(pi, "b");
  await waitFor(() => latestState(pi)?.plan?.executionHistory?.length === 2, { message: "dependent wave after explicit passing checks" });
  const state = latestState(pi);
  assert.deepEqual(pi.delegationRequests.map((request) => request.nodeId), ["a", "b", "merge"]);
  assert.equal(pi.delegationRequests[0].ownerRunId, pi.delegationRequests[1].ownerRunId, "independent tasks share one wave");
  assert.notEqual(pi.delegationRequests[2].ownerRunId, pi.delegationRequests[0].ownerRunId, "dependent task starts only after the first wave is assessed");
  assert.deepEqual(state.plan.tasks.map((item) => item.status), ["done", "done", "done"]);
  assert.equal(state.plan.executionHistory.length, 2);
  assert.ok(state.plan.executionHistory.every((item) => item.status === "completed"));
  assert.ok(state.plan.executionHistory.every((item) => item.wallDurationMs >= 0));
});

test("restarted unresolved execution is marked unknown and can be reconciled without duplicate dispatch", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["API and UI evidence captured"], tasks }, undefined, undefined, ctx(pi));
  const persisted = approvedDagState(structuredClone(latestState(pi)));
  persisted.stateRevision += 1;
  persisted.plan.tasks = persisted.plan.tasks.map((item) => ["api", "ui"].includes(item.id) ? { ...item, status: "in_progress" } : item);
  persisted.plan.execution = {
    requestId: "wave-recovery",
    runId: null,
    taskIds: ["api", "ui"],
    planRevision: persisted.plan.revision,
    stateVersion: persisted.plan.stateVersion,
    status: "running",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    completedAt: null,
    error: null,
    results: ["api", "ui"].map((id) => ({
      id, status: "running", agent: "scout", model: "cliproxyapi/gpt-6-luna",
      fallbackAttempted: false, requestId: `request-${id}`, ownerRunId: "wave-recovery",
      runId: `run-${id}`, error: "", primaryError: "", summary: "", usage: null,
    })),
  };
  pi.appendEntry("pi-compass-v2.goalrun", persisted);
  await pi.events.get("session_start")({}, ctx(pi));
  const recovered = latestState(pi);
  assert.equal(recovered.plan.execution.status, "unknown");
  const steering = "Do not use subagents for this Goal.";
  appendHuman(pi, steering, "new-constraint");
  await pi.events.get("message_end")({ message: { role: "user", id: "new-constraint", content: steering } }, ctx(pi));
  assert.equal(dagApprovalStatus(latestState(pi)).approved, false, "new Human constraints invalidate prior execution approval");
  assert.ok(pi.activeNames().includes("compass_execution"), "recovery control is only surfaced while the batch is unresolved");
  assert.equal(pi.delegationRequests.length, 0, "restoration must not automatically re-dispatch possibly active children");
  const status = await currentTool(pi, "compass_execution").execute("status", { action: "status" }, undefined, undefined, ctx(pi));
  assert.match(status.content[0].text, /wave-recovery/);
  const resolved = await currentTool(pi, "compass_execution").execute("resolve", {
    action: "resolve",
    requestId: "wave-recovery",
    confirmedNoActiveRuns: true,
    confirmationEvidence: "Subagent status showed run-api and run-ui are terminal.",
    results: [
      { id: "api", status: "done", evidence: "API route inspected; src/api.ts:12" },
      { id: "ui", status: "blocked", reason: "UI child ended without usable evidence." },
    ],
  }, undefined, undefined, ctx(pi));
  assert.match(resolved.content[0].text, /Reconciled Subagent batch wave-recovery/);
  const finalState = latestState(pi);
  assert.equal(finalState.plan.execution.status, "completed");
  assert.equal(finalState.plan.tasks.find((item) => item.id === "api").status, "done");
  assert.equal(finalState.plan.tasks.find((item) => item.id === "ui").status, "blocked");
  assert.equal(finalState.plan.executionHistory.at(-1).source, "manual_reconcile");
  assert.equal(pi.delegationRequests.length, 0, "reconciliation consumes supplied evidence without launching a duplicate child");
});

test("auto-dispatch falls back to DeepSeek once for a provider quota failure and records usage/model", async () => {
  const pi = fakePi({
    respondDelegation(request) {
      if (request.model !== "jrt/deepseek-v4.1-flash") {
        return { status: "failed", error: "HTTP 429 insufficient quota", model: request.model };
      }
      return {
        status: "completed",
        model: request.model,
        runId: `fallback-${request.nodeId}`,
        result: { kind: "structured", value: { status: "done", summary: "Fallback found the route.", evidence: [`src/${request.nodeId}.ts:12`], reason: "" } },
        usage: { input: 200, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.002, turns: 1, toolCalls: 2, durationMs: 200 },
      };
    },
  });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const oneTaskPlan = [
    { id: "api", title: "Inspect API", acceptance: "API route documented", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent route inspection benefits from a separate context." },
    { id: "parent", title: "Summarize results", acceptance: "Summary recorded", dependsOn: ["api"], writeScope: "read-only", executor: "parent" },
  ];
  const create = await currentTool(pi, "compass_plan_create").execute("create", {
    acceptanceCriteria: ["API route is evidenced"],
    tasks: oneTaskPlan,
  }, undefined, undefined, ctx(pi));
  await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  await approveDag(pi);
  await waitFor(() => latestState(pi)?.plan?.execution?.status === "completed", { message: "approved DeepSeek fallback completion" });
  const state = latestState(pi);
  assert.deepEqual(pi.delegationRequests.map((request) => request.model), ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"]);
  assert.equal(state.plan.tasks.find((item) => item.id === "api").status, "done");
  assert.equal(state.plan.execution.results[0].fallbackAttempted, true);
  assert.equal(state.plan.execution.results[0].model, "jrt/deepseek-v4.1-flash");
  assert.match(state.plan.execution.results[0].primaryError, /429 insufficient quota/);
  assert.equal(state.plan.execution.status, "completed");
});

test("missing structured-delegation handler fails fast without launching a task", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const create = await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["Both areas are evidenced"], tasks }, undefined, undefined, ctx(pi));
  const started = Date.now();
  await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  assert.ok(Date.now() - started < 5000, "tool_result must not wait for child completion");
  assert.equal(latestState(pi).plan.execution, null, "no bridge check or dispatch occurs while the plan is a draft");
  await approveDag(pi);
  await pi.events.get("before_agent_start")({ prompt: "" }, ctx(pi));
  await waitFor(() => latestState(pi)?.plan?.execution?.status === "failed", { timeoutMs: 5000, message: "missing bridge fail-closed state after approval" });
  const state = latestState(pi);
  assert.equal(state.plan.execution.status, "failed");
  assert.match(state.plan.execution.error, /No correlated invalid_request response/);
  assert.deepEqual(state.plan.tasks.map((item) => item.status), ["pending", "pending", "pending"]);
  assert.equal(pi.delegationRequests.length, 0);
});

test("structured runtime dispatch works while the model-visible native Subagent tool remains hidden", async () => {
  const pi = fakePi({ autoDelegation: true });
  pi.setActiveTools(pi.activeNames().filter((name) => !/subagent/i.test(name)));
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const create = await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: ["Both areas are evidenced"], tasks }, undefined, undefined, ctx(pi));
  const patch = await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  assert.match(patch.content.at(-1).text, /structured Human question/);
  await approveDag(pi);
  await waitFor(() => latestState(pi)?.plan?.execution?.status === "completed", { message: "approved hidden native tool dispatch" });
  const state = latestState(pi);
  assert.equal(state.plan.execution.status, "completed");
  assert.deepEqual(state.plan.tasks.map((item) => item.status), ["done", "done", "pending"]);
  assert.equal(pi.delegationRequests.length, 2, "the structured event API is independent from native tool visibility");
  assert.ok(!pi.activeNames().some((name) => /subagent/i.test(name)), "Compass must not force-enable the model-visible Subagent tool");
  assert.match(patch.content.at(-1).text, /structured Human question/);
});


test("active DAG records explicit out-of-scope writes as advisory drift, but does not global-lock the Agent", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: implement multiple independent workstreams and keep edits within declared task scope");
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create-scoped-write", {
    acceptanceCriteria: ["Source change is implemented within scope"],
    tasks: [
      { id: "edit_src", title: "Edit source", acceptance: "Source file changed", dependsOn: [], writeScope: "src/**", executor: "code" },
      { id: "review_src", title: "Review source change", acceptance: "Source change reviewed", dependsOn: ["edit_src"], writeScope: "read-only", executor: "parent" },
    ],
  }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  await currentTool(pi, "compass_task").execute("start-scoped-write", { action: "start", taskIds: ["edit_src"] }, undefined, undefined, ctx(pi));

  const allowed = await pi.events.get("tool_call")({ toolName: "write", input: { path: "src/a.ts", content: "ok" } }, ctx(pi));
  assert.equal(allowed, undefined, "in-scope path write is allowed");
  const blocked = await pi.events.get("tool_call")({ toolName: "write", input: { path: "README.md", content: "out of scope" } }, ctx(pi));
  assert.equal(blocked, undefined, "path-scope drift is advisory and does not block native writes");
  assert.match(latestState(pi).plan.executionDrift.reason, /outside every declared scope/);

  const mixedPatch = await pi.events.get("tool_call")({ toolName: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch" } }, ctx(pi));
  assert.equal(mixedPatch, undefined, "a patch containing an out-of-scope file remains Agent/native coordination");
});

test("active DAG records writes without a writable task as advisory drift, while simple Goals remain unrestricted", async () => {
  const simple = fakePi();
  extensionFactory(simple);
  await captureGoal(simple, "Goal: change one file");
  assert.equal(await simple.events.get("tool_call")({ toolName: "write", input: { path: "README.md", content: "ok" } }, ctx(simple)), undefined);

  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: implement multiple independent workstreams with a scoped change");
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create-pending-write", {
    acceptanceCriteria: ["Scoped change is implemented"],
    tasks: [
      { id: "edit_src", title: "Edit source", acceptance: "Source changed", dependsOn: [], writeScope: "src/**", executor: "code" },
      { id: "review_src", title: "Review source", acceptance: "Source reviewed", dependsOn: ["edit_src"], writeScope: "read-only", executor: "parent" },
    ],
  }, undefined, undefined, ctx(pi));
  const blocked = await pi.events.get("tool_call")({ toolName: "write", input: { path: "src/a.ts", content: "not yet" } }, ctx(pi));
  assert.equal(blocked, undefined);
  assert.match(latestState(pi).plan.executionDrift.reason, /no writable DAG task was in progress/);
});

test("loader contains only missing capability groups after a partial open", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: implement multiple independent workstreams; define acceptance criteria, preserve checkpoints, and show full original prompt details.");
  await openCapability(pi, "history");
  const loader = currentTool(pi, "compass_open");
  const choices = loader.parameters.properties.capabilities.items.enum;
  assert.ok(!choices.includes("history") && !choices.includes("planning"), "loaded groups cannot appear as redundant choices");
  assert.ok(choices.includes("goal_details") && choices.includes("acceptance"), "still-missing groups remain selectable");
  assert.equal(loader.parameters.properties.capabilities.maxItems, choices.length);
});

test("DAG progress never changes native Subagent activation", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  const before = pi.activeNames().filter((name) => !name.startsWith("compass_"));
  await currentTool(pi, "compass_task").execute("done-api", { action: "done", tasks: [{ id: "api", evidence: "Read API route and recorded source location" }] }, undefined, undefined, ctx(pi));
  assert.deepEqual(pi.activeNames().filter((name) => !name.startsWith("compass_")), before);
  const snapshot = JSON.parse((await currentTool(pi, "compass_state").execute("state", {}, undefined, undefined, ctx(pi))).content[0].text);
  assert.equal(snapshot.runtime, undefined);
  assert.ok(pi.activeNames().includes("subagent"));
  assert.equal(snapshot.plan.done, 1);
});

test("already-completed ready tasks can be closed without a redundant start call", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  const done = currentTool(pi, "compass_task");
  const result = await done.execute("direct-done", { action: "done", tasks: [{ id: "api", evidence: "Read the route and verified the health handler." }] }, undefined, undefined, ctx(pi));
  assert.deepEqual(result.details.completedWithoutStart, ["api"]);
  assert.match(result.content[0].text, /Completed directly from ready\/pending: api/);
  assert.equal(latestState(pi).plan.tasks.find((task) => task.id === "api").status, "done");
  await assert.rejects(
    () => done.execute("blocked-direct-done", { action: "done", tasks: [{ id: "smoke", evidence: "A smoke artifact exists." }] }, undefined, undefined, ctx(pi)),
    /pending and not ready; dependencies unfinished or not semantically checked: api, ui/,
  );
});

test("task transition schemas remain stable and execution revalidates current state", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks: tasks.map((task) => ({ ...task, executor: "code" })) }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  const oldStart = currentTool(pi, "compass_task");
  assert.equal(oldStart.parameters.properties.taskIds.items.enum, undefined, "task IDs are validated at execution so status changes do not invalidate the schema");
  assert.deepEqual(oldStart.parameters.properties.action.enum, ["start", "done", "block", "reopen", "assess"]);
  await assert.rejects(() => oldStart.execute("bad-action-shape", { action: "start", taskIds: ["api"], tasks: [{ id: "ui", evidence: "mixed" }] }, undefined, undefined, ctx(pi)), /requires taskIds and forbids tasks/);
  await assert.rejects(() => oldStart.execute("empty-forbidden-shape", { action: "start", taskIds: ["api"], tasks: [] }, undefined, undefined, ctx(pi)), /requires taskIds and forbids tasks/);
  await oldStart.execute("start", { action: "start", taskIds: ["api", "ui"] }, undefined, undefined, ctx(pi));
  await assert.rejects(() => oldStart.execute("stale-start", { action: "start", taskIds: ["api"] }, undefined, undefined, ctx(pi)), /status|start|pending|in_progress|No state changed/i);
  const done = currentTool(pi, "compass_task");
  assert.equal(done.parameters.properties.tasks.items.properties.id.enum, undefined, "done tool schema remains stable across transitions");
  await assert.rejects(() => done.execute("empty-forbidden-evidence", { action: "done", tasks: [{ id: "api", evidence: "valid", reason: "" }] }, undefined, undefined, ctx(pi)), /forbids reason/);
  const doneResult = await done.execute("done", { action: "done", tasks: [
    { id: "api", evidence: "Read route definitions and health handler." },
    { id: "ui", evidence: "Read primary route and API client." },
  ] }, undefined, undefined, ctx(pi));
  assert.match(doneResult.content[0].text, /Ready: none/);
  const beforeChecks = await currentTool(pi, "compass_plan_status").execute("ready-before-checks", {}, undefined, undefined, ctx(pi));
  assert.ok(!beforeChecks.details.ready.includes("smoke"), "task completion alone does not unlock dependents");
  await assessTask(pi, "api");
  await assessTask(pi, "ui");
  const ready = await currentTool(pi, "compass_plan_status").execute("ready-status", {}, undefined, undefined, ctx(pi));
  assert.ok(ready.details.ready.includes("smoke"), "only passing semantic checks unlock dependencies");
  const revise = currentTool(pi, "compass_plan_revise");
  assert.equal(revise.parameters.properties.expectedStateVersion.enum, undefined, "plan revision version is checked at execution, not baked into a changing schema");
  assert.equal(revise.name, "compass_plan_revise", "task schema changes update the existing tool name rather than creating name variants");
});

test("plan revision uses a plan-state version and rejects stale full-graph overwrites", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks: tasks.map((task) => ({ ...task, executor: "code" })) }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  const oldRevise = currentTool(pi, "compass_plan_revise");
  const oldVersion = latestState(pi).plan.stateVersion;
  await currentTool(pi, "compass_task").execute("start", { action: "start", taskIds: ["api"] }, undefined, undefined, ctx(pi));
  await assert.rejects(() => oldRevise.execute("stale-revise", {
    expectedStateVersion: oldVersion,
    changeReason: "stale test",
    acceptanceCriteria: criteria,
    tasks,
  }, undefined, undefined, ctx(pi)), /Stale plan state version/);
});

test("plan revision explains each invalidated task in the mutation result", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks: tasks.map((task) => ({ ...task, executor: "code" })) }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  await currentTool(pi, "compass_task").execute("start-independent", { action: "start", taskIds: ["api", "ui"] }, undefined, undefined, ctx(pi));
  await currentTool(pi, "compass_task").execute("done-independent", { action: "done", tasks: [
    { id: "api", evidence: "API route and health handler inspected." },
    { id: "ui", evidence: "Primary route and API client inspected." },
  ] }, undefined, undefined, ctx(pi));
  await assessTask(pi, "api");
  await assessTask(pi, "ui");
  await currentTool(pi, "compass_task").execute("start-smoke", { action: "start", taskIds: ["smoke"] }, undefined, undefined, ctx(pi));
  await currentTool(pi, "compass_task").execute("done-smoke", { action: "done", tasks: [{ id: "smoke", evidence: "Smoke path passed." }] }, undefined, undefined, ctx(pi));
  const expectedStateVersion = latestState(pi).plan.stateVersion;
  const revisedTasks = tasks.map((task) => task.id === "api"
    ? { ...task, acceptance: "API route and health semantics are documented with the revised response contract" }
    : task);
  const revised = await currentTool(pi, "compass_plan_revise").execute("revise", {
    expectedStateVersion,
    changeReason: "The API response contract changed based on new source evidence.",
    acceptanceCriteria: criteria,
    tasks: revisedTasks.map((task) => ({ ...task, executor: "code" })),
  }, undefined, undefined, ctx(pi));
  assert.deepEqual(revised.details.invalidated, ["api", "smoke"]);
  assert.equal(revised.details.invalidatedDetails.length, 2);
  assert.match(revised.content[0].text, /api \(done → pending; Reset because this task's definition or dependencies changed during replanning\.\)/);
  assert.match(revised.content[0].text, /smoke \(done → pending; Invalidated because a prerequisite changed during replanning\.\)/);
});

test("identical acceptance reports and no-op plan revisions do not bump state revision", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "acceptance");
  await currentTool(pi, "compass_acceptance_define").execute("define", { criteria: ["The health check returns 200"] }, undefined, undefined, ctx(pi));
  const defined = latestState(pi);
  const defineAgain = await currentTool(pi, "compass_acceptance_define").execute("define-again", { criteria: ["The health check returns 200"] }, undefined, undefined, ctx(pi));
  assert.equal(defineAgain.details.unchanged, true);
  assert.equal(latestState(pi).stateRevision, defined.stateRevision);
  await currentTool(pi, "compass_acceptance_record").execute("record", { criterionId: "AC1", status: "reported_pass", evidence: "curl /health returned HTTP 200" }, undefined, undefined, ctx(pi));
  const recorded = latestState(pi);
  const duplicate = await currentTool(pi, "compass_acceptance_record").execute("record-again", { criterionId: "AC1", status: "reported_pass", evidence: "curl /health returned HTTP 200" }, undefined, undefined, ctx(pi));
  assert.equal(duplicate.details.unchanged, true);
  assert.equal(latestState(pi).stateRevision, recorded.stateRevision);

  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  const beforeNoopRevision = latestState(pi).stateRevision;
  const plan = latestState(pi).plan;
  const noOp = await currentTool(pi, "compass_plan_revise").execute("revise-noop", {
    expectedStateVersion: plan.stateVersion,
    changeReason: "No semantic change",
    acceptanceCriteria: criteria,
    tasks,
  }, undefined, undefined, ctx(pi));
  assert.equal(noOp.details.unchanged, true);
  assert.equal(latestState(pi).stateRevision, beforeNoopRevision);
});

test("acceptance tool accepts bounded evidence above the old 1200-character schema limit", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "acceptance");
  await currentTool(pi, "compass_acceptance_define").execute("define", { criteria: ["The acceptance artifact is reproducible"] }, undefined, undefined, ctx(pi));
  const evidence = `result=PASS; artifact=out/acceptance.json; ${"command and observed output provenance ".repeat(45)}`.slice(0, 1682);
  const result = await currentTool(pi, "compass_acceptance_record").execute("record-long-evidence", { criterionId: "AC1", status: "reported_pass", evidence }, undefined, undefined, ctx(pi));
  assert.equal(result.details.unchanged, false);
  assert.equal(latestState(pi).goal.criteria[0].evidence, evidence);
});

test("Goal continuity works without a DAG; failure details are on demand, not in every anchor", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: inspect the repo and establish a smoke test");
  const messages = [{ role: "user", content: "A tool failed." }];
  const first = await pi.events.get("context")({ messages }, ctx(pi));
  assert.equal(first, undefined, "the native Human message is not repeated in an injected anchor");
  const snapshot = JSON.parse((await currentTool(pi, "compass_state").execute("state", {}, undefined, undefined, ctx(pi))).content[0].text);
  assert.match(snapshot.goal.current, /inspect the repo and establish a smoke test/);
  assert.equal(snapshot.plan, undefined);
  await pi.events.get("tool_execution_end")({ toolName: "bash", isError: true, result: { content: [{ type: "text", text: "command exited 1" }] } }, ctx(pi));
  const second = await pi.events.get("context")({ messages }, ctx(pi));
  assert.equal(second, undefined, "a recorded failure does not trigger per-request context injection");
  assert.ok(currentTool(pi, "compass_open").parameters.properties.capabilities.items.enum.includes("issue_review"));
  await openCapability(pi, "issue_review");
  const triage = await currentTool(pi, "compass_triage").execute("triage", { issue: "Should I change the approach?" }, undefined, undefined, ctx(pi));
  assert.match(triage.content[0].text, /command exited 1/);
});

test("material history works without a DAG", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "history");
  const decision = currentTool(pi, "compass_decision");
  assert.equal(decision.parameters.properties.affectedTaskIds, undefined, "without a DAG, the schema does not invite impossible task references");
  assert.ok(decision.parameters.properties.supersedesDecisionIds, "decision correction is available without a DAG and without changing the schema");
  const result = await decision.execute("decision", { summary: "Do not reset shared DB", rationale: "No disposable DB configured", evidence: "No test DB URL found" }, undefined, undefined, ctx(pi));
  assert.equal(latestState(pi).decisions[0].id, "D1");
  assert.equal("state" in result.details, false, "tool result details stay compact when appendEntry works");
  const corrected = await currentTool(pi, "compass_decision").execute("decision-correction", { summary: "Use a disposable database instead", rationale: "New evidence shows the shared database can be reset safely in the test harness", supersedesDecisionIds: ["D1"] }, undefined, undefined, ctx(pi));
  assert.equal(latestState(pi).decisions.find((item) => item.id === "D1").supersededBy, "D2");
  assert.deepEqual(corrected.details.supersededDecisionIds, ["D1"]);
  assert.match(corrected.content[0].text, /Superseded prior decisions: D1/);
  assert.ok(pi.activeNames().includes("compass_checkpoint"));
});

test("decision schema adds task references only when a DAG exists and accepts useful evidence length", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  await openCapability(pi, "history");
  const decision = currentTool(pi, "compass_decision");
  assert.ok(decision.parameters.properties.affectedTaskIds, "task references are available once a DAG exists");
  const evidence = "source-location-and-observation ".repeat(25);
  await decision.execute("decision", { summary: "Preserve the existing adapter contract", evidence, affectedTaskIds: ["api"] }, undefined, undefined, ctx(pi));
  assert.ok(latestState(pi).decisions[0].evidence.length > 500, "decision evidence is not rejected at 500 chars and remains useful");
  assert.equal(latestState(pi).decisions[0].affectedTaskIds[0], "api");
});

test("runtime does not create a second conventions registry or expose convention tools", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: implement a feature. My local AGENTS.md and repeated Human instructions remain the source of working conventions.", { planning: false });
  assert.ok(!pi.activeNames().some((name) => /compass_convention/i.test(name)));
  assert.ok(![...pi.tools.keys()].some((name) => /compass_convention/i.test(name)));
  assert.ok(pi.activeNames().includes("compass_open"), "optional capabilities are available on demand without classifying the Goal text");
});



test("inactive native Subagents stay inactive without a second Compass visibility policy", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: inspect multiple independent workstreams across four code paths.");
  pi.setActiveTools(pi.activeNames().filter((name) => !/subagent/i.test(name)));
  assert.equal(await pi.events.get("context")({ messages: [{ role: "user", content: "Scout the gaps in parallel" }] }, ctx(pi)), undefined);
  const snapshot = JSON.parse((await currentTool(pi, "compass_state").execute("state", {}, undefined, undefined, ctx(pi))).content[0].text);
  assert.equal(snapshot.runtime, undefined, "native diagnostics stay outside compact Goal state");
  assert.ok(!pi.activeNames().includes("subagent"));
  assert.ok(!pi.activeNames().some((name) => /subagent/i.test(name)));
});


test("successful custom-entry persistence avoids duplicating full state in tool results and restores it", async () => {
  const first = fakePi();
  extensionFactory(first);
  await captureGoal(first, "Goal: persist state once and preserve material decision checkpoints.");
  await openCapability(first, "history");
  const result = await currentTool(first, "compass_decision").execute("decision", { summary: "Keep schema stable", rationale: "Avoid breaking callers", evidence: "Existing public API tests" }, undefined, undefined, ctx(first));
  assert.equal("state" in result.details, false);
  assert.ok(first.entries.some((entry) => entry.customType === "pi-compass-v2.goalrun"));

  const second = fakePi();
  extensionFactory(second);
  const branch = first.branch();
  await second.events.get("session_start")({}, { cwd: "/tmp/example-project", sessionManager: { getBranch: () => branch, getEntries: () => branch } });
  assert.equal(latestState(second).goal.current, "Goal: persist state once and preserve material decision checkpoints.");
  assert.equal(latestState(second).decisions.at(-1).summary, "Keep schema stable");
  assert.ok(second.activeNames().includes("compass_state"));
});

test("parallel state mutations serialize; one stale mutation fails without racing", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks: tasks.map((task) => ({ ...task, executor: "code" })) }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  const start = currentTool(pi, "compass_task");
  const calls = await Promise.allSettled([
    start.execute("start-a", { action: "start", taskIds: ["api"] }, undefined, undefined, ctx(pi)),
    start.execute("start-b", { action: "start", taskIds: ["api"] }, undefined, undefined, ctx(pi)),
  ]);
  assert.equal(calls.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(calls.filter((result) => result.status === "rejected").length, 1);
  const state = latestState(pi);
  assert.equal(state.plan.tasks.filter((task) => task.status === "in_progress").length, 1);
});

test("parallel task mutations serialize without a global-epoch conflict, but duplicate transitions are rejected", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks: tasks.map((task) => ({ ...task, executor: "code" })) }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  const start = currentTool(pi, "compass_task");
  const independent = await Promise.allSettled([
    start.execute("start-api", { action: "start", taskIds: ["api"] }, undefined, undefined, ctx(pi)),
    start.execute("start-ui", { action: "start", taskIds: ["ui"] }, undefined, undefined, ctx(pi)),
  ]);
  assert.equal(independent.filter((item) => item.status === "fulfilled").length, 2);
  await assert.rejects(() => start.execute("duplicate", { action: "start", taskIds: ["api"] }, undefined, undefined, ctx(pi)), /api|status|pending|ready/i);
});

test("restored capability does not churn schemas on every context request", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "history");
  const firstNames = pi.activeNames().filter((name) => name.startsWith("compass_"));
  const messages = [{ role: "user", content: "Continue the task." }];
  await pi.events.get("context")({ messages }, ctx(pi));
  const afterFirst = pi.activeNames().filter((name) => name.startsWith("compass_"));
  await pi.events.get("context")({ messages }, ctx(pi));
  const afterSecond = pi.activeNames().filter((name) => name.startsWith("compass_"));
  assert.deepEqual(afterFirst, afterSecond);
  assert.ok(firstNames.length >= 3);
});

test("capability entry and fixed history tools keep stable names; decision does not invalidate checkpoint", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  const initialEntry = currentTool(pi, "compass_open").name;
  await openCapability(pi, "history");
  assert.equal(currentTool(pi, "compass_open").name, initialEntry);
  const decision = currentTool(pi, "compass_decision");
  const checkpoint = currentTool(pi, "compass_checkpoint");
  await decision.execute("decision", { summary: "Keep rendering validation honest", rationale: "No PowerPoint runtime is available", evidence: "Only LibreOffice is installed" }, undefined, undefined, ctx(pi));
  assert.ok(pi.activeNames().includes("compass_checkpoint"), "checkpoint stays active after a decision write");
  const saved = await checkpoint.execute("checkpoint", { summary: "After render tests", ref: "git:abc123", evidence: "709 tests pass" }, undefined, undefined, ctx(pi));
  assert.match(saved.content[0].text, /Recorded C1/);
});

test("Goal replacement preserves applicable loaded capability groups and avoids stale tool disappearance", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: fix eight integration issues across multiple independent workstreams; define acceptance criteria and preserve decision checkpoints.");
  await openCapability(pi, "planning");
  await openCapability(pi, "history");
  await openCapability(pi, "acceptance");
  await currentTool(pi, "compass_acceptance_define").execute("define", { criteria: ["All issues are dispositioned"] }, undefined, undefined, ctx(pi));
  await sendHuman(pi, "Goal: integrate the upstream plugin and remove the obsolete adapter", "new-goal");
  await submitGoal(pi, "Integrate the upstream plugin and remove the obsolete adapter");
  const state = latestState(pi);
  assert.equal(state.goal.version, 2);
  assert.ok(state.activeCapabilities.includes("planning"));
  assert.ok(state.activeCapabilities.includes("history"));
  assert.ok(state.activeCapabilities.includes("acceptance"));
  assert.ok(pi.activeNames().includes("compass_plan_create"), "planning remains available but its task lifecycle resets for the new Goal");
  assert.ok(pi.activeNames().includes("compass_decision"), "history tools remain available across the Goal transition");
  assert.ok(pi.activeNames().includes("compass_acceptance_define"), "new Goal can define its own acceptance criteria without reopening the group");
});


test("questionnaire hooks require a persisted assistant source, not a provider-call claim", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: choose a deployment route");
  await pi.events.get("tool_execution_end")({
    toolName: "ask_user_question",
    toolCallId: "fabricated-call-id",
    isError: false,
    result: { details: { answers: [{ questionIndex: 0, question: "Route?", kind: "custom", answer: "SSH" }] } },
  }, ctx(pi));
  assert.equal(latestState(pi).humanDecisions.length, 0, "a provider call ID without a persisted assistant tool call is not Human-decision identity");
});

test("ask-user-questions answers remain available on demand without repeated injection", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: complete the PPTX delivery");
  persistToolCall(pi, "ask-call-1");
  await pi.events.get("tool_execution_end")({
    toolName: "ask_user_question",
    toolCallId: "ask-call-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `User has answered your questions: "Delivery"="Push origin/main only"; "PowerPoint"="Unavailable; use LibreOffice evidence". selected preview: ${"large-preview-body ".repeat(200)}` }],
      details: {
        cancelled: false,
        answers: [
          { questionIndex: 0, question: "Delivery?", kind: "option", answer: "Push origin/main only", preview: "large-preview-body" },
          { questionIndex: 1, question: "PowerPoint?", kind: "custom", answer: "Unavailable; use LibreOffice evidence" },
        ],
      },
    },
  }, ctx(pi));
  const state = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1).data;
  assert.equal(state.humanDecisions.length, 1);
  assert.match(state.humanDecisions[0].text, /Push origin\/main only/);
  assert.equal(state.humanDecisions[0].questionnaire.outcome, "answered");
  assert.equal(state.humanDecisions[0].questionnaire.answers.length, 2);
  assert.doesNotMatch(JSON.stringify(state.humanDecisions[0]), /large-preview-body/);
  const projected = await pi.events.get("context")({ messages: [{ role: "user", content: "Continue" }] }, ctx(pi));
  assert.equal(projected, undefined);
  const snapshot = JSON.parse((await currentTool(pi, "compass_state").execute("state", {}, undefined, undefined, ctx(pi))).content[0].text);
  assert.equal(snapshot.humanDecisions, undefined, "detailed answers are not repeated in compact state");
  await openCapability(pi, "goal_details");
  const details = await currentTool(pi, "compass_goal_read").execute("read-goal", {}, undefined, undefined, ctx(pi));
  assert.match(details.content[0].text, /Push origin\/main only/);
  assert.match(details.content[0].text, /PowerPoint/);
});

test("ask-user-question UI load failures are not recorded as Human declines", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: continue the implementation after a Human choice");
  persistToolCall(pi, "ask-call-error");
  const original = {
    toolName: "ask_user_question",
    toolCallId: "ask-call-error",
    content: [{ type: "text", text: "User declined to answer questions" }],
    details: { answers: [], cancelled: true, error: "session_load_failed" },
    isError: false,
  };
  const patch = await pi.events.get("tool_result")(original, ctx(pi));
  assert.equal(patch.isError, true);
  assert.match(patch.content[0].text, /not a Human decline/);
  assert.equal(patch.content[1].text, "User declined to answer questions");
  assert.equal(patch.details.error, "session_load_failed");
  await pi.events.get("tool_execution_end")({
    toolName: "ask_user_question",
    toolCallId: "ask-call-error",
    isError: true,
    result: patch,
  }, ctx(pi));
  const state = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1).data;
  assert.equal(state.humanDecisions.length, 0);
  assert.equal(state.events.at(-1).kind, "human_questionnaire_error");
  assert.equal(state.events.at(-1).status, "session_load_failed");
  assert.equal(state.trace.failures.length, 0, "the structured questionnaire failure is not double-counted as a generic tool failure");
});

test("capability groups are additive and do not hide previously loaded tools", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  assert.ok(pi.activeNames().includes("compass_plan_create"));
  await openCapability(pi, "history");
  assert.ok(pi.activeNames().includes("compass_plan_create"), "opening history must not hide planning");
  assert.ok(pi.activeNames().includes("compass_decision"));
  const state = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1).data;
  assert.deepEqual(new Set(state.activeCapabilities), new Set(["planning", "history"]));
});

test("plan tool loadout refreshes at the request boundary while lifecycle tool schemas stay stable", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const create = pi.tools.get("compass_plan_create");
  await create.execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  assert.ok(pi.activeNames().includes("compass_plan_create"), "current response's tool loadout is not replaced mid-batch");
  assert.ok(!pi.activeNames().includes("compass_task"));
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.ok(!pi.activeNames().includes("compass_plan_create"));
  assert.ok(pi.activeNames().includes("compass_task"));
  assert.ok(pi.activeNames().includes("compass_acceptance_record"));
});

test("path-based writes report scope drift immediately without injecting a Goal anchor", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const scopedTasks = [
    { id: "inspect-a", title: "Inspect area A", acceptance: "Relevant evidence is recorded", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent area A inspection benefits from separate context." },
    { id: "inspect-b", title: "Inspect area B", acceptance: "Relevant evidence is recorded", dependsOn: [], writeScope: "read-only", executor: "subagent", agent: "scout", dispatchReason: "Independent area B inspection benefits from separate context." },
    { id: "edit-a", title: "Edit file A", acceptance: "Only file A changes", dependsOn: [], writeScope: "src/a.ts", executor: "code" },
  ];
  await currentTool(pi, "compass_plan_create").execute("create-scoped", { acceptanceCriteria: ["The requested change is correct"], tasks: scopedTasks }, undefined, undefined, ctx(pi));
  await approveDag(pi);
  await currentTool(pi, "compass_task").execute("start-writer", { action: "start", taskIds: ["edit-a"] }, undefined, undefined, ctx(pi));
  await pi.events.get("tool_call")({ toolName: "edit", input: { path: "src/a.ts" } }, ctx(pi));
  assert.equal(latestState(pi).plan.executionDrift, null, "a write within the declared scope does not create drift");
  const blocked = await pi.events.get("tool_call")({ toolName: "edit", input: { path: "src/outside.ts" } }, ctx(pi));
  assert.equal(blocked, undefined, "an explicit out-of-scope write remains Agent/native coordination");
  assert.match(latestState(pi).plan.executionDrift.reason, /outside every declared scope/i);
  const context = await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.equal(context, undefined, "do not repeat the failure in every later provider request");
});

test("repeated current-Goal failures automatically surface issue review at a request boundary", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  for (let i = 0; i < 3; i += 1) {
    await pi.events.get("tool_execution_end")({ toolName: "bash", isError: true, result: { content: [{ type: "text", text: `same route failed ${i + 1}` }] } }, ctx(pi));
  }
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.ok(pi.activeNames().includes("compass_triage"));
  const state = pi.entries.filter((entry) => entry.customType === "pi-compass-v2.goalrun").at(-1).data;
  assert.ok(state.activeCapabilities.includes("issue_review"));
});

test("preflight reports dynamic tool activation and native dependencies", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  let notice = "";
  await pi.commands.get("compass-preflight").handler("", { ui: { notify(message) { notice = message; } } });
  assert.match(notice, /PASS GoalRun module export contract/);
  assert.match(notice, /PASS Pi active-tool read\/write/);
  assert.match(notice, /PASS Stable-name schema replacement/);
  assert.ok(notice.includes(`Compass v${GOAL_RUN_RELEASE} preflight`));
  assert.match(notice, /Compass loader/);
  assert.match(notice, /PASS codemode/);
  assert.match(notice, /PASS pi-subagents registered/);
  assert.match(notice, /activation owned by Pi\/pi-subagents and the user/);
  assert.match(notice, /pi-await: watch=true; watches=true; unwatch=true/);
  assert.match(notice, /PASS ask-user-questions/);
});


test("preflight distinguishes the Subagent loader from the inactive executor", async () => {
  const pi = fakePi();
  pi.setActiveTools(pi.activeNames().filter((name) => name !== "subagent"));
  extensionFactory(pi);
  await captureGoal(pi, "Goal: inspect one file.");
  let notice = "";
  await pi.commands.get("compass-preflight").handler("", { ui: { notify(message) { notice = message; } } });
  assert.match(notice, /Subagent tools: registered but inactive/);
  assert.match(notice, /Subagent loader: visible/);
  assert.doesNotMatch(notice, /Subagent tools: visible/);
});

test("compact state exposes Goal and frame without repeating native diagnostics", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  assert.ok(pi.activeNames().includes("compass_state"));
  const stateTool = currentTool(pi, "compass_state");
  const first = await stateTool.execute("state", {}, undefined, undefined, ctx(pi));
  const snapshot = JSON.parse(first.content[0].text);
  assert.equal(snapshot.v, 8);
  assert.equal(snapshot.goal.version, 1);
  assert.equal(snapshot.outcome, "not_assessed");
  assert.equal(snapshot.runtime, undefined);
  assert.equal(snapshot.delta, undefined);
  assert.equal(snapshot.acceptance, undefined);
  assert.equal(snapshot.plan, undefined);
  assert.ok(first.content[0].text.length < 500, "fresh summary omits duplicate Goal events, diagnostics, empty arrays and zero counts");
  const unchanged = await currentTool(pi, "compass_state").execute("state2", { cursor: snapshot.cursor }, undefined, undefined, ctx(pi));
  assert.equal(JSON.parse(unchanged.content[0].text).unchanged, true);
  assert.ok(unchanged.content[0].text.length < 200, "unchanged reads return only the cursor/revision envelope");
  const beforeInvalidRead = latestState(pi);
  appendHuman(pi, "A clarification not yet observed by Compass.");
  await assert.rejects(() => stateTool.execute("invalid-state", { maxEvents: 0 }, undefined, undefined, ctx(pi)), /No state changed/);
  assert.deepEqual(latestState(pi), beforeInvalidRead, "read validation fails before observing or persisting a new input");
});

test("Human parallel scouting does not create a DAG or replace native activation", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi, "Goal: inspect multiple independent workstreams across four code paths.");
  const native = pi.activeNames().filter((name) => !name.startsWith("compass_"));
  await pi.events.get("message_end")({ message: { role: "user", content: [{ type: "text", text: "Scout the gaps in parallel." }] } }, ctx(pi));
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.deepEqual(pi.activeNames().filter((name) => !name.startsWith("compass_")), native);
  assert.equal(latestState(pi).plan.tasks.length, 0);
});

test("pi-subagents can switch its loader and native tool without Compass undoing it", async () => {
  const pi = fakePi();
  pi.setActiveTools(pi.activeNames().filter((name) => name !== "subagent"));
  extensionFactory(pi);
  await captureGoal(pi, "Goal: fix one typo in one file.");
  assert.ok(pi.activeNames().includes("subagents_enable"));
  assert.ok(!pi.activeNames().includes("subagent"));
  pi.setActiveTools([...pi.activeNames().filter((name) => name !== "subagents_enable"), "subagent"]);
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.ok(pi.activeNames().includes("subagent"));
  assert.ok(!pi.activeNames().includes("subagents_enable"));
  assert.ok(pi.activeNames().includes("bg_wait"));
  assert.ok(pi.activeNames().includes("watch"));
});

test("Human prohibition blocks automatic DAG dispatch without rewriting native tools", async () => {
  const pi = fakePi({ autoDelegation: true });
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  const create = await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  await pi.events.get("message_end")({ message: { role: "user", content: "Do not use subagents for this Goal." } }, ctx(pi));
  const patch = await pi.events.get("tool_result")({ toolName: "compass_plan_create", input: {}, content: create.content, details: create.details, isError: false }, ctx(pi));
  assert.match(patch.content.at(-1).text, /Before any DAG task starts/);
  assert.equal(latestState(pi).plan.execution, null, "a later Human constraint invalidates the draft approval binding");
  assert.equal(pi.delegationRequests.length, 0);
  assert.ok(pi.activeNames().includes("subagent"), "native schema visibility is not execution authorization");
});

test("Subagent eligibility never force-enables a native tool disabled before Compass loads", async () => {
  const pi = fakePi();
  pi.setActiveTools(pi.activeNames().filter((name) => !/subagent/i.test(name)));
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  assert.ok(!pi.activeNames().some((name) => /subagent/i.test(name)));
  const state = JSON.parse((await currentTool(pi, "compass_state").execute("state", {}, undefined, undefined, ctx(pi))).content[0].text);
  assert.equal(state.runtime, undefined);
  assert.ok(!pi.activeNames().includes("subagent"));
});

test("native tool visibility changes advance state revision without re-enabling user-disabled tools", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await openCapability(pi, "planning");
  await currentTool(pi, "compass_plan_create").execute("create", { acceptanceCriteria: criteria, tasks }, undefined, undefined, ctx(pi));
  assert.ok(pi.activeNames().some((name) => /subagent/i.test(name)), "Compass preserves the native active toolset");
  const initial = JSON.parse((await currentTool(pi, "compass_state").execute("state", {}, undefined, undefined, ctx(pi))).content[0].text);
  const beforeRevision = latestState(pi).stateRevision;
  pi.setActiveTools(pi.activeNames().filter((name) => !/subagent/i.test(name)));
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.ok(latestState(pi).stateRevision > beforeRevision, "native capability changes are reflected in the composite cursor revision");
  assert.ok(!pi.activeNames().some((name) => /subagent/i.test(name)), "Compass does not force-enable a tool disabled by the user");
  const after = JSON.parse((await currentTool(pi, "compass_state").execute("state-after", { cursor: initial.cursor }, undefined, undefined, ctx(pi))).content[0].text);
  assert.notEqual(after.cursor, initial.cursor);
  assert.equal(after.unchanged, undefined);
  assert.equal(after.runtime, undefined);
});

test("triage uses evidence references and returns a compact duplicate result", async () => {
  const pi = fakePi();
  extensionFactory(pi);
  await captureGoal(pi);
  await pi.events.get("tool_execution_end")({ toolName: "bash", isError: true, result: { content: [{ type: "text", text: "test failed: expected 200 got 500" }] } }, ctx(pi));
  await pi.events.get("tool_execution_end")({ toolName: "bash", isError: true, result: { content: [{ type: "text", text: "test failed: expected 200 got 500" }] } }, ctx(pi));
  await pi.events.get("tool_execution_end")({ toolName: "bash", isError: true, result: { content: [{ type: "text", text: "test failed: expected 200 got 500" }] } }, ctx(pi));
  await pi.events.get("context")({ messages: [] }, ctx(pi));
  assert.ok(pi.activeNames().includes("compass_triage"));
  const stateTool = currentTool(pi, "compass_state");
  const snapshot = JSON.parse((await stateTool.execute("state", { cursor: "R0-E0-C0" }, undefined, undefined, ctx(pi))).content[0].text);
  const event = snapshot.delta.events.find((item) => item.kind === "tool_failure");
  assert.ok(event);
  const triage = currentTool(pi, "compass_triage");
  const first = await triage.execute("triage", { evidenceRefs: [event.id] }, undefined, undefined, ctx(pi));
  assert.match(first.content[0].text, new RegExp(event.id));
  const second = await currentTool(pi, "compass_triage").execute("triage2", { evidenceRefs: [event.id] }, undefined, undefined, ctx(pi));
  assert.match(second.content[0].text, /"duplicate":true/);
  assert.ok(second.content[0].text.length < 900);
});
