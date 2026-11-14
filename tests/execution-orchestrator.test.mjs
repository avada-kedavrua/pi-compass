import test from "node:test";
import assert from "node:assert/strict";
import {
  DELEGATION_EVENTS,
  FALLBACK_MODEL,
  PRIMARY_MODEL,
  REVIEW_MODEL,
  isSupportedDelegatedModel,
  TASK_RESULT_SCHEMA,
  assessWavePolicy,
  buildSubagentDelegationRequest,
  buildTaskPrompt,
  hasCompleteUsageMetrics,
  isRetryableProviderFailure,
  providerFallbackReason,
  normalizeProviderDiagnostics,
  parseSubagentDelegationResponse,
  selectReadySubagentTasks,
} from "../src/execution-orchestrator.mjs";
import { emptyDagState, createOrRevisePlan, taskAssessmentBinding, updateTasks } from "../src/dag-core.mjs";
import { bindDagApprovalQuestionnaire, captureHumanDecision } from "../src/goal-run.mjs";
import { DAG_APPROVAL_OPTION } from "../src/dag-approval.mjs";
import { emptyGoalRunState, captureHumanPrompt, normalizeGoalRunState, recordExecutionDrift, recordExecutionEvent, transitionTasks, revisePlanState } from "../src/goal-run.mjs";

const task = (id, overrides = {}) => ({
  id,
  title: `Task ${id}`,
  acceptance: `Observable result for ${id}`,
  dependsOn: [],
  writeScope: "read-only",
  executor: "subagent",
  agent: "scout",
  dispatchReason: "Independent read-only investigation needs a separate context.",
  status: "pending",
  ...overrides,
});


test("effective pi-subagents model identity allows documented thinking suffix, never arbitrary models", () => {
  for (const model of [PRIMARY_MODEL, REVIEW_MODEL, FALLBACK_MODEL]) {
    assert.equal(isSupportedDelegatedModel(model), true);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert.equal(isSupportedDelegatedModel(`${model}:${level}`), true, `${model}:${level}`);
    }
    for (const suffix of [":ultra", ":high:evil", ":", ":high extra"]) {
      assert.equal(isSupportedDelegatedModel(`${model}${suffix}`), false, `${model}${suffix}`);
    }
  }
  for (const bad of [null, undefined, "gpt-6-luna", "cliproxyapi/gpt-6-luna-extra", "cliproxyapi/gpt-6-luna:high:bad", "cliproxyapi/gpt-7-luna:high", ""])
    assert.equal(isSupportedDelegatedModel(bad), false, String(bad));
  assert.equal(isSupportedDelegatedModel("cliproxyapi/gpt-6-luna:high", [PRIMARY_MODEL, FALLBACK_MODEL]), true);
  assert.equal(isSupportedDelegatedModel("cliproxyapi/gpt-6.1-sol:high", [PRIMARY_MODEL, FALLBACK_MODEL]), false, "scout-only allowlist excludes reviewer model");
});

test("ready Subagent selection requires explicit read-only executor and satisfied prerequisites", () => {
  const plan = {
    tasks: [
      task("a"),
      task("b", { dependsOn: ["a"] }),
      task("c", { executor: "code" }),
      task("d", { status: "in_progress" }),
      task("e", { writeScope: "src/**" }),
    ],
  };
  assert.deepEqual(selectReadySubagentTasks(plan).map((item) => item.id), ["a"]);
  assert.deepEqual(selectReadySubagentTasks(plan, 1).map((item) => item.id), ["a"]);
  plan.tasks[0].status = "done";
  plan.tasks[0].assessment = { status: "pass", binding: taskAssessmentBinding(plan, plan.tasks[0]) };
  assert.deepEqual(selectReadySubagentTasks(plan).map((item) => item.id), ["b"]);
});

test("DAG validation rejects Subagent tasks without explicit read-only scope", () => {
  assert.throws(() => createOrRevisePlan(emptyDagState(), {
    goal: "inspect two independent areas",
    acceptanceCriteria: ["Evidence collected"],
    tasks: [task("a", { writeScope: "src/a.ts" }), task("b", { executor: "parent", writeScope: "src/b.ts" })],
  }), /executor=subagent.*writeScope="read-only"/);
});

test("delegation request uses the public structured event contract and a bounded schema", () => {
  const request = buildSubagentDelegationRequest({
    task: { ...task("api"), title: "Inspect API", output: "route references" },
    goal: "Map the API health path",
    constraints: ["Do not install dependencies."],
    cwd: "/tmp/project",
    ownerRunId: "wave-123",
    requestId: "request-123",
  });
  assert.equal(DELEGATION_EVENTS.request, "prompt-template:subagent:request");
  assert.equal(DELEGATION_EVENTS.response, "prompt-template:subagent:response");
  assert.equal(request.requestId, "request-123");
  assert.equal(request.ownerRunId, "wave-123");
  assert.equal(request.nodeId, "api");
  assert.equal(request.agent, "scout");
  assert.equal(request.context, "fresh");
  assert.equal(request.model, PRIMARY_MODEL);
  assert.equal(request.thinking, "high");
  assert.equal(request.result.kind, "structured");
  assert.deepEqual(request.result.schema, TASK_RESULT_SCHEMA);
  assert.match(request.task, /Current Goal: Map the API health path/);
  assert.match(request.task, /Do not install dependencies/);
  assert.match(request.task, /Do not edit, write, delete, install, commit/);
  assert.deepEqual(request.toolBudget, { soft: 18, hard: 28, block: ["read", "grep", "find", "ls"] });
  assert.throws(() => buildSubagentDelegationRequest({
    task: { ...task("unsafe"), writeScope: "src/**" },
    goal: "Inspect",
    cwd: "/tmp/project",
    ownerRunId: "wave",
    requestId: "request",
  }), /not explicitly routed to a read-only Subagent/);
});

test("provider diagnostics and explicit account exhaustion drive one DeepSeek fallback without treating vague quota text as proof", () => {
  assert.equal(FALLBACK_MODEL, "jrt/deepseek-v4.1-flash");
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "HTTP 429 insufficient quota" }), true);
  assert.equal(providerFallbackReason({ status: "failed", error: "primary request failed", providerDiagnostics: { errorCount: 2, lastError: { kind: "rate_limited", message: "Provider request was rate-limited.", at: 10 } } }), "primary_provider_rate_limited");
  assert.equal(providerFallbackReason({ status: "failed", error: "primary request failed", providerDiagnostics: { errorCount: 1, lastError: { kind: "transient_other", message: "Transient provider request error.", at: 10 } } }), "primary_provider_transient_error");
  assert.equal(providerFallbackReason({ status: "failed", error: "Account has insufficient quota", providerDiagnostics: { errorCount: 1, lastError: { kind: "unknown", message: "Provider request failed.", at: 10 } } }), "primary_account_quota_exhausted", "clear account exhaustion uses the user's requested backup even though upstream deliberately labels it unknown");
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "The prompt mentions quota but no provider failure is specified." }), false);
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "Billing information was included in the request." }), false);
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "provider temporarily unavailable (503)" }), true);
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "Subagent run timed out after 600000ms", providerDiagnostics: { lastError: { kind: "transient_other" } } }), false);
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "ECONNRESET", providerDiagnostics: { lastError: { kind: "transient_other" } } }), false);
  assert.equal(isRetryableProviderFailure({ status: "timed_out", error: "HTTP 429 insufficient quota" }), false);
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "Task could not find the expected route" }), false);
  assert.equal(isRetryableProviderFailure({ status: "failed", error: "invalid structured output" }), false);
  assert.equal(normalizeProviderDiagnostics({ errorCount: 1, lastError: { kind: "unknown", message: "safe message", at: 12 }, retry: { phase: "backoff", attempt: 1, maxAttempts: 3, delayMs: 100, scheduledAt: 13 } }).lastError.kind, "unknown");
  assert.equal(normalizeProviderDiagnostics({ errorCount: -1, lastError: { kind: "secret_kind", message: "raw" } }).lastError, null);
});

test("structured terminal responses are correlated by request, owner, and node identity", () => {
  const response = {
    requestId: "req-a",
    ownerRunId: "wave-a",
    nodeId: "api",
    status: "completed",
    runId: "run-42",
    model: "cliproxyapi/gpt-6-luna",
    result: {
      kind: "structured",
      value: {
        status: "done",
        summary: "Found the health route and its handler.",
        evidence: ["src/server/routes.ts:42", "src/server/health.ts:8"],
        reason: "",
      },
    },
    usage: { input: 1000, output: 120, cacheRead: 800, cacheWrite: 0, cost: 0.012, turns: 2, toolCalls: 5, durationMs: 4200 },
    providerDiagnostics: { errorCount: 1, lastError: { kind: "rate_limited", message: "Provider request was rate-limited.", at: 10 }, retry: { phase: "backoff", attempt: 1, maxAttempts: 3, delayMs: 100, scheduledAt: 10 } },
  };
  const parsed = parseSubagentDelegationResponse(response, { requestId: "req-a", ownerRunId: "wave-a", nodeId: "api", model: PRIMARY_MODEL });
  assert.equal(parsed.status, "done");
  assert.equal(parsed.runId, "run-42");
  assert.equal(parsed.evidence.length, 2);
  assert.equal(parsed.usage.cost, 0.012);
  assert.equal(parsed.providerDiagnostics.lastError.kind, "rate_limited");
  assert.equal(parsed.providerDiagnostics.retry.phase, "backoff");
  assert.equal(parseSubagentDelegationResponse(response, { requestId: "other", ownerRunId: "wave-a", nodeId: "api" }), null);
  assert.equal(parseSubagentDelegationResponse(response, { requestId: "req-a", ownerRunId: "other", nodeId: "api" }), null);
  assert.equal(parseSubagentDelegationResponse(response, { requestId: "req-a", ownerRunId: "wave-a", nodeId: "other" }), null);
});

test("observed progress tool activity survives structured response parsing without exposing tool arguments", () => {
  const parsed = parseSubagentDelegationResponse({
    requestId: "req-progress", ownerRunId: "wave-progress", nodeId: "progress", status: "completed",
    result: { kind: "structured", value: { status: "done", summary: "Inspected files.", evidence: ["README.md:1"], reason: "" } },
    __compassProgress: { toolCount: 2, tools: ["read", "ls", "read"] },
  }, { requestId: "req-progress", ownerRunId: "wave-progress", nodeId: "progress" });
  assert.equal(parsed.observedToolCount, 2);
  assert.deepEqual(parsed.observedTools, ["read", "ls"]);
  assert.ok(!JSON.stringify(parsed).includes("args"), "only tool names, not potentially sensitive tool arguments, are retained");
});

test("provider diagnostics survive bounded response parsing and GoalRun normalization", () => {
  const parsed = parseSubagentDelegationResponse({
    requestId: "req-provider", ownerRunId: "wave-provider", nodeId: "provider", status: "completed",
    result: { kind: "structured", value: { status: "done", summary: "Found provider behavior.", evidence: ["docs/provider.md:8"], reason: "" } },
    providerDiagnostics: { errorCount: 2, lastError: { kind: "unknown", message: "Safe fixed description", at: 10 }, retry: { phase: "in_flight", attempt: 2, maxAttempts: 3, delayMs: 0, scheduledAt: 11 } },
  }, { requestId: "req-provider", ownerRunId: "wave-provider", nodeId: "provider" });
  let state = captureHumanPrompt(emptyGoalRunState(), "Goal: inspect provider behavior").state;
  state.plan = { ...state.plan, goal: state.goal.current, revision: 1, tasks: [task("provider"), task("provider-note", { executor: "parent", dependsOn: ["provider"] })] };
  state.plan.execution = {
    requestId: "wave-provider", taskIds: ["provider"], planRevision: state.plan.revision, status: "completed",
    results: [{ id: "provider", status: "done", model: PRIMARY_MODEL, requestId: parsed.requestId, ownerRunId: parsed.ownerRunId,
      fallbackAttempted: true, fallbackReason: "primary_account_quota_exhausted", providerDiagnostics: parsed.providerDiagnostics,
      primaryProviderDiagnostics: { errorCount: 1, lastError: { kind: "unknown", message: "Primary account quota exhausted", at: 9 } },
      usage: { input: 1, output: 1, cost: 0.01, toolCalls: 1, durationMs: 20 } }],
  };
  state.plan.executionHistory = [{ requestId: "wave-provider", taskIds: ["provider"], status: "completed", taskMetrics: [{ id: "provider", model: PRIMARY_MODEL, fallbackAttempted: true, fallbackReason: "primary_account_quota_exhausted", providerErrorCount: 2, providerLastErrorKind: "unknown", providerRetryPhase: "in_flight" }] }];
  const normalized = normalizeGoalRunState(state);
  assert.equal(normalized.plan.execution.results[0].fallbackReason, "primary_account_quota_exhausted");
  assert.equal(normalized.plan.execution.results[0].providerDiagnostics.lastError.kind, "unknown");
  assert.equal(normalized.plan.execution.results[0].primaryProviderDiagnostics.errorCount, 1);
  assert.equal(normalized.plan.executionHistory[0].taskMetrics[0].providerErrorCount, 2);
  assert.equal(normalized.plan.executionHistory[0].taskMetrics[0].providerRetryPhase, "in_flight");
});

test("missing provider usage fields remain unknown instead of being reported as zero cost", () => {
  const parsed = parseSubagentDelegationResponse({
    requestId: "req-metrics", ownerRunId: "wave-metrics", nodeId: "metrics", status: "completed",
    result: { kind: "structured", value: { status: "done", summary: "Found a result.", evidence: ["README.md:1"], reason: "" } },
    usage: { input: 120, output: 30 },
  }, { requestId: "req-metrics", ownerRunId: "wave-metrics", nodeId: "metrics" });
  assert.equal(parsed.usage.input, 120);
  assert.equal(parsed.usage.cost, null);
  assert.equal(parsed.usage.durationMs, null);
  assert.equal(hasCompleteUsageMetrics(parsed.usage), false);
  assert.equal(hasCompleteUsageMetrics({ input: 1, output: 1, cost: 0, toolCalls: 0, durationMs: 1 }), true, "an explicit zero is valid when the provider actually reports it");
});

test("a completed child without concrete evidence is not marked done", () => {
  const parsed = parseSubagentDelegationResponse({
    requestId: "req",
    ownerRunId: "wave",
    nodeId: "a",
    status: "completed",
    result: { kind: "structured", value: { status: "done", summary: "Done", evidence: [], reason: "" } },
  }, { requestId: "req", ownerRunId: "wave", nodeId: "a" });
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.reason, /without concrete evidence/);
});

test("a child-reported blocker is preserved as a blocker, not upgraded to success", () => {
  const parsed = parseSubagentDelegationResponse({
    requestId: "req",
    ownerRunId: "wave",
    nodeId: "a",
    status: "completed",
    result: { kind: "structured", value: { status: "blocked", summary: "No route evidence found", evidence: [], reason: "The repository lacks the expected route." } },
  }, { requestId: "req", ownerRunId: "wave", nodeId: "a" });
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.reason, /lacks the expected route/);
});

test("child prompt preserves Goal and hard constraints while explicitly forbidding writes", () => {
  const prompt = buildTaskPrompt({ goal: "Inspect the authentication path", task: task("auth", { title: "Trace token validation", acceptance: "Relevant call chain and evidence" }), constraints: ["Do not install dependencies."] });
  assert.match(prompt, /Do not edit, write, delete, install, commit/);
  assert.match(prompt, /Current Goal: Inspect the authentication path/);
  assert.match(prompt, /Do not install dependencies/);
  assert.match(prompt, /Task ID: auth/);
  assert.match(prompt, /Why a separate Subagent context is justified/);
  assert.match(prompt, /structured result/);
});

test("material DAG revisions are refused while a Subagent batch is unresolved", () => {
  let state = captureHumanPrompt(emptyGoalRunState(), "Goal: inspect and update two scoped areas").state;
  const tasks = [
    task("a", { executor: "code", writeScope: "src/a.ts" }),
    task("b", { executor: "code", writeScope: "src/b.ts" }),
  ];
  state = revisePlanState(state, { acceptanceCriteria: ["Both scoped changes are correct"], tasks }).state;
  state.plan.execution = { requestId: "batch-1", runId: "run-1", taskIds: ["a"], planRevision: state.plan.revision, stateVersion: state.plan.stateVersion, status: "running" };
  assert.throws(() => revisePlanState(state, {
    acceptanceCriteria: ["Both scoped changes are correct"],
    changeReason: "New evidence changes task A",
    tasks: tasks.map((item) => item.id === "a" ? { ...item, acceptance: "A's updated completion condition" } : item),
  }), /reconcile the batch first/);
  assert.equal(state.plan.tasks[0].acceptance, "Observable result for a", "failed replan must not mutate the current graph");
});

test("execution events and usage metadata survive GoalRun normalization", () => {
  let state = captureHumanPrompt(emptyGoalRunState(), "Goal: inspect two independent read-only areas").state;
  state.plan = createOrRevisePlan(state.plan, {
    goal: state.goal.current,
    acceptanceCriteria: ["Both areas are understood"],
    tasks: [task("a"), task("b")],
  });
  state.plan.execution = {
    requestId: "wave",
    frameScope: "frame-root",
    taskIds: ["a", "b"],
    planRevision: state.plan.revision,
    stateVersion: state.plan.stateVersion,
    status: "completed",
    results: [{
      id: "a", status: "done", agent: "scout", model: PRIMARY_MODEL, fallbackAttempted: false,
      requestId: "req-a", ownerRunId: "wave", runId: "run-a", frameScope: "frame-a", summary: "Found entry point",
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: 0.01, turns: 1, toolCalls: 2, durationMs: 500 },
    }],
  };
  state = recordExecutionEvent(state, { status: "completed", summary: "Wave completed", text: "a=done" });
  const normalized = normalizeGoalRunState(state);
  assert.equal(normalized.plan.execution.frameScope, "frame-root");
  assert.equal(normalized.plan.execution.results[0].runId, "run-a");
  assert.equal(normalized.plan.execution.results[0].frameScope, "frame-a");
  assert.equal(normalized.plan.execution.results[0].usage.cost, 0.01);
  assert.ok(normalized.events.some((item) => item.kind === "subagent_execution"));
});

test("GoalRun normalization preserves unknown usage/cost fields as null", () => {
  let state = captureHumanPrompt(emptyGoalRunState(), "Goal: inspect usage metadata").state;
  state.plan = createOrRevisePlan(state.plan, { goal: state.goal.current, acceptanceCriteria: ["Usage metadata preserved"], tasks: [task("a"), task("b")] });
  state.plan.execution = {
    requestId: "wave-missing-metrics", taskIds: ["a"], planRevision: state.plan.revision, status: "completed",
    results: [{ id: "a", status: "done", model: PRIMARY_MODEL, fallbackAttempted: false, requestId: "req-a", ownerRunId: "wave-missing-metrics", runId: "run-a", usage: { input: 100, output: 20 } }],
  };
  state.plan.executionHistory = [{ requestId: "wave-missing-metrics", taskIds: ["a"], status: "completed", metricsComplete: false }];
  const normalized = normalizeGoalRunState(state);
  assert.equal(normalized.plan.execution.results[0].usage.cost, null);
  assert.equal(normalized.plan.execution.results[0].usage.durationMs, null);
  assert.equal(normalized.plan.executionHistory[0].totalCost, null);
  assert.equal(normalized.plan.executionHistory[0].estimatedParallelSavingsMs, null);
});

function approvePlan(state) {
  const request = state.plan.approvalRequest;
  const callId = `approval-${request.id}`;
  const sourceEntryId = `entry-${request.id}`;
  const bound = bindDagApprovalQuestionnaire(state, { questions: [structuredClone(request.questionnaire)] }, sourceEntryId, callId);
  assert.equal(bound.bound, true);
  return captureHumanDecision(bound.state, {
    source: "ask_user_question",
    sourceEntryId,
    sourceCallId: callId,
    details: { answers: [{ questionIndex: 0, question: request.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION] }] },
  }).state;
}

test("runtime drift records a compact warning once and the next Goal anchor explains recovery", () => {
  let state = captureHumanPrompt(emptyGoalRunState(), "Goal: implement two related changes").state;
  state = revisePlanState(state, { acceptanceCriteria: ["Both changes pass"], tasks: [task("a", { executor: "code", writeScope: "src/a.ts" }), task("b", { executor: "code", writeScope: "src/b.ts" })] }).state;
  state = approvePlan(state);
  const first = recordExecutionDrift(state, { tool: "edit", target: "/tmp/project/src/a.ts", reason: "No writable task is in progress." });
  const second = recordExecutionDrift(first.state, { tool: "edit", target: "/tmp/project/src/a.ts", reason: "No writable task is in progress." });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  const started = transitionTasks(first.state, "start", [{ id: "a" }], updateTasks).state;
  assert.equal(started.plan.executionDrift, null, "an explicit task lifecycle update clears the pending drift nudge");
});


test("Subagent wave policy parallelizes justified cold-start work but cools down after repeated provider fallbacks", () => {
  const ready = [task("a"), task("b")];
  const cold = assessWavePolicy(ready, []);
  assert.equal(cold.mode, "parallel_cold_start");
  assert.equal(cold.maxTasks, 2);
  const history = [
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 1, metricsComplete: true, estimatedParallelSavingsMs: 25_000 },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 30_000 },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 1, metricsComplete: true, estimatedParallelSavingsMs: 20_000 },
  ];
  const cooled = assessWavePolicy(ready, history);
  assert.equal(cooled.mode, "provider_cooldown");
  assert.equal(cooled.maxTasks, 1);
});

test("provider cooldown clears after two successful single-child waves instead of remaining stuck forever", () => {
  const ready = [task("a"), task("b"), task("c")];
  const history = [
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 1, metricsComplete: true, estimatedParallelSavingsMs: 25000 },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 30000 },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 1, metricsComplete: true, estimatedParallelSavingsMs: 20000 },
    { status: "completed", taskIds: ["a"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 0 },
    { status: "completed", taskIds: ["b"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 0 },
  ];
  const policy = assessWavePolicy(ready, history);
  assert.notEqual(policy.mode, "provider_cooldown");
  assert.equal(policy.maxTasks, 3, "successful serialized trials release provider cooldown when measured parallel benefit remains positive");
});

test("Subagent wave policy serializes only after repeated measured waves show little wait-time benefit", () => {
  const ready = [task("a"), task("b"), task("c")];
  const history = [
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 1200 },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 2500 },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 4000 },
  ];
  const policy = assessWavePolicy(ready, history);
  assert.equal(policy.mode, "serial_short_tasks");
  assert.equal(policy.maxTasks, 1);
  assert.ok(policy.medianSavingsMs <= 5000);
});

test("low-savings serialization cools down and re-probes rather than staying serial forever", () => {
  const ready = [task("a"), task("b"), task("c")];
  const history = [
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 1200, policyMode: "parallel_observed_benefit" },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 2500, policyMode: "parallel_observed_benefit" },
    { status: "completed", taskIds: ["x", "y"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 4000, policyMode: "parallel_observed_benefit" },
    { status: "completed", taskIds: ["a"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 0, policyMode: "serial_short_tasks" },
  ];
  const cooldown = assessWavePolicy(ready, history);
  assert.equal(cooldown.mode, "serial_short_tasks");
  assert.equal(cooldown.maxTasks, 1);

  history.push({ status: "completed", taskIds: ["b"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 0, policyMode: "serial_short_tasks" });
  const reprobe = assessWavePolicy(ready, history);
  assert.equal(reprobe.mode, "parallel_reprobe");
  assert.equal(reprobe.maxTasks, 3);

  history.push({ status: "completed", taskIds: ["c", "d"], fallbackCount: 0, metricsComplete: true, estimatedParallelSavingsMs: 25_000, policyMode: "parallel_reprobe" });
  const freshWindow = assessWavePolicy(ready, history);
  assert.notEqual(freshWindow.mode, "serial_short_tasks", "old low-savings waves must not immediately relock the scheduler");
  assert.equal(freshWindow.maxTasks, 3);
});

test("Subagent selection requires an explicit separate-context cost-benefit rationale", () => {
  const plan = { tasks: [task("a", { dispatchReason: "" }), task("b")] };
  assert.deepEqual(selectReadySubagentTasks(plan).map((item) => item.id), ["b"]);
  assert.throws(() => createOrRevisePlan(emptyDagState(), {
    goal: "inspect independent areas",
    acceptanceCriteria: ["Evidence collected"],
    tasks: [
      { id: "a", title: "Inspect A", acceptance: "Evidence A", executor: "subagent", writeScope: "read-only" },
      { id: "b", title: "Inspect B", acceptance: "Evidence B", executor: "subagent", writeScope: "read-only", dispatchReason: "Independent review needs separate context." },
    ],
  }), /must provide dispatchReason/);
});
