import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyGoalRunState,
  normalizeGoalRunState,
  captureHumanPrompt,
  captureHumanDecision,
  recordHumanQuestionnaireFailure,
  explicitGoalChangeUpdates,
  applyGoalChange,
  dismissGoalChangeCandidate,
  recordDecision,
  recordCheckpoint,
  recordFailure,
  mergeTrace,
  buildGoalAnchor,
  buildIssueReview,
  availableCapabilities,
  defineAcceptanceCriteria,
  recordAcceptanceResult,
  acceptanceStatus,
  goalOutcomeStatus,
  planningActivationSignal,
  buildRecentEvents,
  buildStateSnapshot,
  triageIssue,
  buildGoalDetails,
  summarizePlanStatus,
  transitionTasks,
  reconcileUnknownExecutionTasks,
  revisePlanState,
  bindDagApprovalQuestionnaire,
  renewDagApprovalRequest,
  dagApprovalStatus,
  recordTaskAssessment,
  createRouteSet,
  bindRouteSetQuestionnaire,
  recordRouteSelection,
  proposeRouteExploration,
  registerCompetitorRun,
  recordCompetitorResult,
  selectRoute,
  updateCompetitorCancellation,
  routeSetStatus,
} from "../src/goal-run.mjs";
import { DAG_APPROVAL_OPTION } from "../src/dag-approval.mjs";
import { createOrRevisePlan, emptyDagState, readyTasks, updateTasks } from "../src/dag-core.mjs";

const acceptanceCriteria = ["API request returns expected data", "Started processes are cleaned up"];
const tasks = [
  { id: "api", title: "Inspect API", acceptance: "API route and health semantics documented", dependsOn: [], writeScope: "read-only" },
  { id: "ui", title: "Inspect UI", acceptance: "Primary route and request path documented", dependsOn: [], writeScope: "read-only" },
  { id: "smoke", title: "Implement smoke path", acceptance: "Critical UI-to-API path is exercised", dependsOn: ["api", "ui"], writeScope: "src/smoke" },
];

function withGoal(prompt = "Create a reliable full-stack smoke test") {
  return captureHumanPrompt(emptyGoalRunState(), prompt).state;
}
function approvalInput(request) { return { questions: [structuredClone(request.questionnaire)] }; }
function approvePlan(state) {
  const request = state.plan.approvalRequest;
  const callId = `approval-${request.id}`;
  const sourceEntryId = `entry-${request.id}`;
  const bound = bindDagApprovalQuestionnaire(state, approvalInput(request), sourceEntryId, callId);
  assert.equal(bound.bound, true);
  return captureHumanDecision(bound.state, {
    source: "ask_user_question",
    sourceEntryId,
    sourceCallId: callId,
    details: { answers: [{ questionIndex: 0, question: request.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION] }] },
  }).state;
}
function withPlan(state) {
  return approvePlan(revisePlanState(state, { acceptanceCriteria, tasks }).state);
}
function completeAndAssess(state, taskId, evidence) {
  state = transitionTasks(state, "done", [{ id: taskId, evidence }], updateTasks).state;
  return recordTaskAssessment(state, { taskId, status: "pass", evidence: `Assessment against approved criterion: ${evidence}`, caveats: [], unresolvedCaveats: [] }).state;
}
function routeState() {
  const state = withGoal("Goal: compare two implementation strategies");
  return createRouteSet(state, {
    expectedStateVersion: 0,
    baselineRef: "git:baseline",
    acceptanceCriteria: ["Shared smoke test passes"],
    routes: [{ routeId: "routeA", summary: "Use the existing adapter" }, { routeId: "routeB", summary: "Replace the adapter" }],
  }).state;
}
function humanSelectRoute(state, routeId) {
  const request = state.routeSet.selectionRequest;
  const sourceEntryId = `route-entry-${request.id}`;
  state = bindRouteSetQuestionnaire(state, { expectedStateVersion: state.routeSet.stateVersion,
    questionnaire: { questions: [request.questionnaire] } }, sourceEntryId, `route-call-${request.id}`).state;
  return recordRouteSelection(state, {
    expectedStateVersion: state.routeSet.stateVersion,
    selectionRequestId: request.id,
    sourceEntryId,
    sourceCallId: `route-call-${request.id}`,
    questionnaire: { outcome: "answered", answers: [{ questionIndex: 0, question: request.questionnaire.question,
      answer: routeId, selected: [routeId], kind: "option" }] },
  }).state;
}
function authorizeRoutes(state) {
  state = proposeRouteExploration(state, { expectedStateVersion: state.routeSet.stateVersion,
    scope: "read-only evidence only", budget: 4, routeIds: ["routeA", "routeB"] }).state;
  const request = state.routeSet.selectionRequest;
  const sourceEntryId = `route-entry-${request.id}`;
  state = bindRouteSetQuestionnaire(state, { expectedStateVersion: state.routeSet.stateVersion,
    questionnaire: { questions: [request.questionnaire] } }, sourceEntryId, `route-call-${request.id}`).state;
  return recordRouteSelection(state, {
    expectedStateVersion: state.routeSet.stateVersion,
    selectionRequestId: request.id,
    sourceEntryId,
    sourceCallId: `route-call-${request.id}`,
    questionnaire: { outcome: "answered", answers: [{ questionIndex: 0, question: request.questionnaire.question,
      answer: "parallel_exploration", selected: ["parallel_exploration"], kind: "option" }] },
  }).state;
}

test("RouteSet rejects unauthorized parallel exploration", () => {
  const state = routeState();
  assert.throws(() => registerCompetitorRun(state, {
    expectedStateVersion: 1, runId: "run-a", routeId: "routeA", baselineRef: "git:baseline", correlationId: "corr-a",
  }), /not explicitly Human-authorized/);
  assert.equal(routeSetStatus(state).exploration.authorized, false);
});

test("exploration proposal is not authorization and ignores unrelated Human decisions", () => {
  let state = captureHumanDecision(routeState(), { source: "human", text: "Use the short summary for this discussion." }).state;
  const proposed = proposeRouteExploration(state, { expectedStateVersion: 1, sourceDecisionId: state.humanDecisions[0].id,
    scope: "read-only evidence only", budget: 4, routeIds: ["routeA", "routeB"] });
  state = proposed.state;
  assert.equal(state.routeSet.exploration.authorized, false);
  assert.equal(state.routeSet.exploration.scope, "read-only evidence only");
  assert.notEqual(proposed.selectionRequest.id, "RS1-select");
  assert.equal(proposed.selectionRequest.questionnaire.options.length, 3);
  assert.match(proposed.selectionRequest.questionnaire.options.at(-1).preview, /Current Goal v1/);
  assert.match(proposed.selectionRequest.questionnaire.options.at(-1).preview, /baseline=git:baseline/);
  assert.match(proposed.selectionRequest.questionnaire.options.at(-1).preview, /Shared acceptance criteria/);
  assert.match(proposed.selectionRequest.questionnaire.options.at(-1).preview, /Maximum competitor runs: 4/);
  assert.match(proposed.selectionRequest.questionnaire.options.at(-1).preview, /routeA/);
  assert.match(proposed.selectionRequest.questionnaire.options.at(-1).preview, /routeB/);
  assert.throws(() => registerCompetitorRun(state, { expectedStateVersion: 2, runId: "run-a", routeId: "routeA",
    baselineRef: "git:baseline", correlationId: "corr-a" }), /not explicitly Human-authorized/);
});

test("exploration proposal scope, budget and route list are bound to a fresh four-option questionnaire", () => {
  let state = captureHumanPrompt(emptyGoalRunState(), "Goal: compare three approaches").state;
  state = createRouteSet(state, { expectedStateVersion: 0, baselineRef: "git:baseline", acceptanceCriteria: ["shared check"],
    routes: ["A", "B", "C"].map((routeId) => ({ routeId, summary: `Approach ${routeId}` })) }).state;
  assert.equal(state.routeSet.selectionRequest.questionnaire.options.length, 3);
  const initialRequest = state.routeSet.selectionRequest;
  const bareQuestion = bindRouteSetQuestionnaire(state, { expectedStateVersion: 1, questionnaire: initialRequest.questionnaire }, "bare-entry");
  assert.equal(bareQuestion.bound, false, "bare Q is not the native { questions: [Q] } payload");
  const initialRequestId = state.routeSet.selectionRequest.id;
  state = proposeRouteExploration(state, { expectedStateVersion: 1, scope: "read-only checks", budget: 6, routeIds: ["A", "C"] }).state;
  const firstRequest = state.routeSet.selectionRequest;
  assert.equal(firstRequest.questionnaire.options.length, 4);
  assert.match(firstRequest.questionnaire.options.at(-1).preview, /\[included\] A/);
  assert.match(firstRequest.questionnaire.options.at(-1).preview, /\[not included\] B/);
  assert.match(firstRequest.questionnaire.options.at(-1).preview, /\[included\] C/);
  state = proposeRouteExploration(state, { expectedStateVersion: 2, scope: "different exact scope", budget: 3, routeIds: ["A", "B"] }).state;
  assert.notEqual(state.routeSet.selectionRequest.id, firstRequest.id);
  assert.notEqual(firstRequest.id, initialRequestId);
  assert.match(state.routeSet.selectionRequest.questionnaire.options.at(-1).preview, /different exact scope/);
  assert.match(state.routeSet.selectionRequest.questionnaire.options.at(-1).preview, /Maximum competitor runs: 3/);
  assert.equal(bindRouteSetQuestionnaire(state, { expectedStateVersion: 3,
    questionnaire: { questions: [firstRequest.questionnaire] } }, "stale-entry").bound, false);
  assert.throws(() => recordRouteSelection(state, { expectedStateVersion: 3, selectionRequestId: firstRequest.id,
    sourceEntryId: "stale-entry", questionnaire: { outcome: "answered", answers: [] } }), /identity is stale/);
  const changed = structuredClone(state);
  changed.routeSet.exploration.scope = "tampered after preview";
  assert.equal(bindRouteSetQuestionnaire(changed, { expectedStateVersion: 3,
    questionnaire: { questions: [changed.routeSet.selectionRequest.questionnaire] } }, "tampered-entry").bound, false);
});

test("route questionnaire answer must correlate to the exact question and contain one note-free option", () => {
  const base = proposeRouteExploration(routeState(), { expectedStateVersion: 1, scope: "read-only", budget: 2,
    routeIds: ["routeA", "routeB"] }).state;
  const tryAnswer = (questionnaire) => {
    let state = structuredClone(base);
    const request = state.routeSet.selectionRequest;
    const sourceEntryId = `entry-${request.id}`;
    state = bindRouteSetQuestionnaire(state, { expectedStateVersion: 2, questionnaire: { questions: [request.questionnaire] } }, sourceEntryId).state;
    return recordRouteSelection(state, { expectedStateVersion: 2, selectionRequestId: request.id, sourceEntryId, questionnaire });
  };
  const answer = { questionIndex: 0, question: base.routeSet.selectionRequest.questionnaire.question,
    kind: "option", answer: "parallel_exploration", selected: ["parallel_exploration"] };
  for (const invalid of [
    { outcome: "answered", answers: [{ ...answer, questionIndex: 1 }] },
    { outcome: "answered", answers: [{ ...answer, notes: "but also do something else" }] },
    { outcome: "answered", globalNote: "add an unapproved extra scope", answers: [answer] },
    { outcome: "answered", answers: [{ ...answer, selected: ["parallel_exploration", "routeA"] }] },
  ]) assert.throws(() => tryAnswer(invalid), /clear, note-free, correlated structured Human answer/);
});

test("route selection answers require both the persisted entry and call identity", () => {
  const state = routeState();
  const request = state.routeSet.selectionRequest;
  const sourceEntryId = "route-question-entry";
  const sourceCallId = "route-question-call";
  const bound = bindRouteSetQuestionnaire(state, { expectedStateVersion: state.routeSet.stateVersion,
    questionnaire: { questions: [request.questionnaire] } }, sourceEntryId, sourceCallId).state;
  const answer = { outcome: "answered", answers: [{ questionIndex: 0, question: request.questionnaire.question,
    answer: "routeA", selected: ["routeA"], kind: "option" }] };
  const input = { expectedStateVersion: bound.routeSet.stateVersion, selectionRequestId: request.id, sourceEntryId,
    sourceCallId: "different-call", questionnaire: answer };
  assert.throws(() => recordRouteSelection(bound, input), /identity is stale/);
  assert.equal(bound.routeSet.selectionRequest.status, "presented");
});

test("RouteSet bounds alternatives at three and direct select cannot bypass the Human choice", () => {
  const state = routeState();
  assert.throws(() => createRouteSet(withGoal(), { expectedStateVersion: 0, baselineRef: "git:b", acceptanceCriteria: ["check"],
    routes: ["A", "B", "C", "D"].map((routeId) => ({ routeId, summary: routeId })) }), /2..3 alternatives/);
  assert.throws(() => selectRoute(state, { expectedStateVersion: 1, routeId: "routeA" }), /only if it was already Human-selected/);
  assert.equal(state.routeSet.selectedRouteId, null);
  assert.equal(humanSelectRoute(state, "routeA").routeSet.selectedRouteId, "routeA");
});

test("RouteSet rejects duplicate normalized criteria and reserved route IDs without mutation", () => {
  const base = withGoal("Goal: compare alternatives");
  const common = { expectedStateVersion: 0, baselineRef: "git:baseline", routes: [{ routeId: "A", summary: "A" }, { routeId: "B", summary: "B" }] };
  assert.throws(() => createRouteSet(base, { ...common, acceptanceCriteria: ["x", { id: "C1", text: "y" }] }), /Duplicate shared acceptance criterion/);
  assert.throws(() => createRouteSet(base, { ...common, acceptanceCriteria: ["x"], routes: [{ routeId: "parallel_exploration", summary: "A" }, { routeId: "B", summary: "B" }] }), /reserved/);
  assert.equal(base.routeSet, null);
});

test("RouteSet preserves exact competitor identity and shared acceptance evidence", () => {
  let state = authorizeRoutes(routeState());
  state = registerCompetitorRun(state, { expectedStateVersion: 3, runId: "run-a", routeId: "routeA", baselineRef: "git:baseline", correlationId: "corr-a" }).state;
  assert.throws(() => recordCompetitorResult(state, { expectedStateVersion: 4, runId: "run-a", routeId: "routeB", correlationId: "corr-a", criteria: [{ id: "C1", status: "pass", evidence: "ok" }] }), /identity.*stale/);
  const result = recordCompetitorResult(state, { expectedStateVersion: 4, runId: "run-a", routeId: "routeA", correlationId: "corr-a", criteria: [{ id: "C1", status: "pass", evidence: "shared smoke test passed" }] });
  assert.equal(result.acceptanceGate, "passed");
  assert.equal(result.state.routeSet.competitorRuns[0].result.criteria[0].id, "C1");
});

test("RouteSet replaces winning evidence safely and rejects nonterminal cancellation outcomes", () => {
  let state = authorizeRoutes(routeState());
  for (const [runId, routeId] of [["run-a", "routeA"], ["run-b", "routeB"], ["run-c", "routeA"]]) {
    state = registerCompetitorRun(state, { expectedStateVersion: state.routeSet.stateVersion, runId, routeId, baselineRef: "git:baseline", correlationId: `corr-${runId}` }).state;
  }
  state = recordCompetitorResult(state, { expectedStateVersion: state.routeSet.stateVersion, runId: "run-a", routeId: "routeA", correlationId: "corr-run-a", criteria: [{ id: "C1", status: "pass", evidence: "pass" }] }).state;
  state = selectRoute(state, { expectedStateVersion: state.routeSet.stateVersion, routeId: "routeA" }).state;
  state = recordCompetitorResult(state, { expectedStateVersion: state.routeSet.stateVersion, runId: "run-a", routeId: "routeA", correlationId: "corr-run-a", criteria: [{ id: "C1", status: "fail", evidence: "replacement failed" }] }).state;
  state = recordCompetitorResult(state, { expectedStateVersion: state.routeSet.stateVersion, runId: "run-b", routeId: "routeB", correlationId: "corr-run-b", criteria: [{ id: "C1", status: "pass", evidence: "pass" }] }).state;
  assert.equal(state.routeSet.winningRouteId, null);
  assert.throws(() => updateCompetitorCancellation(state, { expectedStateVersion: state.routeSet.stateVersion, action: "request", runId: "run-b", routeId: "routeB", correlationId: "corr-run-b", requestId: "cancel" }), /current accepted winning route/);
  state = selectRoute(state, { expectedStateVersion: state.routeSet.stateVersion, routeId: "routeB" }).state;
  state = updateCompetitorCancellation(state, { expectedStateVersion: state.routeSet.stateVersion, action: "request", runId: "run-c", routeId: "routeA", correlationId: "corr-run-c", requestId: "cancel" }).state;
  const before = structuredClone(state);
  assert.throws(() => updateCompetitorCancellation(state, { expectedStateVersion: state.routeSet.stateVersion, action: "terminal", runId: "run-c", routeId: "routeA", correlationId: "corr-run-c", requestId: "cancel", terminalStatus: "running" }), /documented native terminal outcome/);
  assert.deepEqual(state, before);
  state = updateCompetitorCancellation(state, { expectedStateVersion: state.routeSet.stateVersion, action: "terminal", runId: "run-c", routeId: "routeA", correlationId: "corr-run-c", requestId: "cancel", terminalStatus: "cancelled" }).state;
  assert.equal(state.routeSet.competitorRuns.find((run) => run.runId === "run-c").status, "cancelled");
});

test("RouteSet cancellation is acceptance-gated and tracks unknown termination", () => {
  let state = authorizeRoutes(routeState());
  state = registerCompetitorRun(state, { expectedStateVersion: 3, runId: "run-a", routeId: "routeA", baselineRef: "git:baseline", correlationId: "corr-a" }).state;
  state = registerCompetitorRun(state, { expectedStateVersion: 4, runId: "run-b", routeId: "routeB", baselineRef: "git:baseline", correlationId: "corr-b" }).state;
  assert.throws(() => updateCompetitorCancellation(state, { expectedStateVersion: 5, action: "request", runId: "run-b", routeId: "routeB", correlationId: "corr-b", requestId: "cancel-1" }), /acceptance-gated/);
  state = recordCompetitorResult(state, { expectedStateVersion: 5, runId: "run-a", routeId: "routeA", correlationId: "corr-a", criteria: [{ id: "C1", status: "pass", evidence: "accepted route evidence" }] }).state;
  state = selectRoute(state, { expectedStateVersion: 6, routeId: "routeA" }).state;
  state = updateCompetitorCancellation(state, { expectedStateVersion: 7, action: "request", runId: "run-b", routeId: "routeB", correlationId: "corr-b", requestId: "cancel-1" }).state;
  state = updateCompetitorCancellation(state, { expectedStateVersion: 8, action: "unknown", runId: "run-b", routeId: "routeB", correlationId: "corr-b", requestId: "cancel-1" }).state;
  assert.equal(state.routeSet.competitorRuns.find((run) => run.runId === "run-b").status, "unknown");
  assert.equal(state.routeSet.competitorRuns.find((run) => run.runId === "run-b").cancellation.phase, "unknown");
});

test("approval correlation and questionnaire deduplication use both persisted identities", () => {
  let state = revisePlanState(withGoal(), { acceptanceCriteria, tasks }).state;
  const request = state.plan.approvalRequest;
  const entryId = "same-assistant-entry";
  const callId = "approval-call";
  state = bindDagApprovalQuestionnaire(state, approvalInput(request), entryId, callId).state;
  const details = { answers: [{ questionIndex: 0, question: request.question, kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION] }] };
  const wrong = captureHumanDecision(state, { source: "ask_user_question", sourceEntryId: entryId, sourceCallId: "other-call", details });
  assert.equal(dagApprovalStatus(wrong.state).approved, false);
  const right = captureHumanDecision(wrong.state, { source: "ask_user_question", sourceEntryId: entryId, sourceCallId: callId, details });
  assert.equal(dagApprovalStatus(right.state).approved, true);
  assert.equal(captureHumanDecision(right.state, { source: "ask_user_question", sourceEntryId: entryId, sourceCallId: callId, details }).captured, false);
  const failed = recordHumanQuestionnaireFailure(right.state, { sourceEntryId: entryId, sourceCallId: "failure-one", errorCode: "no_ui" });
  const anotherFailure = recordHumanQuestionnaireFailure(failed.state, { sourceEntryId: entryId, sourceCallId: "failure-two", errorCode: "no_ui" });
  assert.equal(anotherFailure.captured, true);
});

test("questionnaire failures correlate and deduplicate by persisted entry and call pair", () => {
  const state = revisePlanState(withGoal(), { acceptanceCriteria, tasks }).state;
  const request = state.plan.approvalRequest;
  const entryId = "same-entry";
  const callId = "bound-call";
  const bound = bindDagApprovalQuestionnaire(state, approvalInput(request), entryId, callId).state;
  const unrelated = recordHumanQuestionnaireFailure(bound, { sourceEntryId: entryId, sourceCallId: "other-call", errorCode: "no_ui" });
  assert.equal(unrelated.state.plan.approvalRequest.status, "presented");
  const failure = recordHumanQuestionnaireFailure(unrelated.state, { sourceEntryId: entryId, sourceCallId: callId, errorCode: "no_ui" });
  assert.equal(failure.state.plan.approvalRequest.status, "questionnaire_error");
  assert.equal(recordHumanQuestionnaireFailure(failure.state, { sourceEntryId: entryId, sourceCallId: callId, errorCode: "no_ui" }).kind, "duplicate");
  assert.equal(recordHumanQuestionnaireFailure(failure.state, { sourceEntryId: entryId, sourceCallId: "another-call", errorCode: "no_ui" }).captured, true);
});

test("confirmed terminal execution facts reconcile despite stale approval without advancing dependencies", () => {
  let state = withPlan(withGoal());
  state = transitionTasks(state, "start", [{ id: "api" }], updateTasks).state;
  state.plan.execution = { requestId: "native-batch", status: "unknown", taskIds: ["api"], planRevision: state.plan.revision };
  state = captureHumanPrompt(state, "Do not use the existing API; preserve the existing Goal and constraints.").state;
  assert.equal(dagApprovalStatus(state).approved, false);
  const reconciled = reconcileUnknownExecutionTasks(state, "native-batch", [{ id: "api", status: "done", evidence: "native terminal result" }], updateTasks).state;
  assert.equal(reconciled.plan.tasks.find((task) => task.id === "api").status, "done");
  assert.equal(reconciled.plan.tasks.find((task) => task.id === "ui").status, "pending");
  assert.throws(() => transitionTasks(reconciled, "start", [{ id: "ui" }], updateTasks), /current correlated Human approval/);
});

test("selected RouteSet route stays isolated from the DAG until the Agent creates one", () => {
  let state = routeState();
  state = humanSelectRoute(state, "routeA");
  assert.equal(state.plan.tasks.length, 0);
  assert.equal(state.routeSet.selectedRouteId, "routeA");
  assert.equal(state.plan.routeId, undefined);
});

test("selecting a route rebinds an existing unscoped DAG and requires fresh approval", () => {
  for (const structured of [false, true]) {
    let state = withPlan(withGoal());
    state = createRouteSet(state, { expectedStateVersion: 0, baselineRef: "git:baseline", acceptanceCriteria,
      routes: [{ routeId: "routeA", summary: "Existing approach" }, { routeId: "routeB", summary: "Alternative" }] }).state;
    assert.equal(dagApprovalStatus(state).approved, false);
    const before = state.plan.revision;
    if (structured) {
      const request = state.routeSet.selectionRequest;
      state = bindRouteSetQuestionnaire(state, { expectedStateVersion: 1, questionnaire: { questions: [request.questionnaire] } }, "route-entry").state;
      state = recordRouteSelection(state, { expectedStateVersion: 1, selectionRequestId: request.id, sourceEntryId: "route-entry",
        questionnaire: { outcome: "answered", answers: [{ questionIndex: 0, question: request.questionnaire.question, kind: "option", answer: "routeA", selected: ["routeA"] }] } }).state;
    } else state = humanSelectRoute(state, "routeA");
    assert.equal(state.plan.routeId, "routeA");
    assert.ok(state.plan.revision > before);
    assert.equal(state.plan.approval, null);
    assert.throws(() => transitionTasks(state, "start", [{ id: "api" }], updateTasks), /approval/);
    state = approvePlan(state);
    assert.equal(dagApprovalStatus(state).approved, true);
    assert.equal(transitionTasks(state, "start", [{ id: "api" }], updateTasks).state.plan.tasks[0].status, "in_progress");
  }
});

test("Human route switching resets route-bound DAG evidence and requires fresh approval", () => {
  let state = withPlan(withGoal());
  state = createRouteSet(state, { expectedStateVersion: 0, baselineRef: "git:baseline", acceptanceCriteria,
    routes: [{ routeId: "routeA", summary: "Original approach" }, { routeId: "routeB", summary: "Alternative" }] }).state;
  state = humanSelectRoute(state, "routeA");
  state = approvePlan(state);
  state = completeAndAssess(state, "api", "existing route A evidence");
  const revision = state.plan.revision;
  assert.throws(() => selectRoute(state, { expectedStateVersion: 2, routeId: "routeB" }), /only if it was already Human-selected/);
  state = proposeRouteExploration(state, { expectedStateVersion: 2, scope: "read-only comparison", budget: 2,
    routeIds: ["routeA", "routeB"] }).state;
  state = humanSelectRoute(state, "routeB");
  assert.equal(state.routeSet.selectedRouteId, "routeB");
  assert.equal(state.plan.routeId, "routeB");
  assert.ok(state.plan.revision > revision);
  assert.equal(state.plan.tasks.find((task) => task.id === "api").status, "pending");
  assert.equal(state.plan.tasks.find((task) => task.id === "api").evidence, "");
  assert.equal(state.plan.approval, null);
  assert.equal(state.plan.approvalRequest.status, "awaiting_questionnaire");
  assert.throws(() => transitionTasks(state, "start", [{ id: "api" }], updateTasks), /approval/);
});

test("route switching refuses to reset an unresolved execution", () => {
  let state = routeState();
  state = humanSelectRoute(state, "routeA");
  state = proposeRouteExploration(state, { expectedStateVersion: 2, scope: "read-only", budget: 2,
    routeIds: ["routeA", "routeB"] }).state;
  state.plan.tasks = [{ id: "work", title: "Work", status: "pending", dependsOn: [], acceptance: "done", writeScope: "read-only" }];
  state.plan.routeId = "routeA";
  state.plan.execution = { requestId: "batch-1", taskIds: ["work"], planRevision: state.plan.revision,
    stateVersion: state.stateRevision, status: "running" };
  const request = state.routeSet.selectionRequest;
  const sourceEntryId = `entry-${request.id}`;
  state = bindRouteSetQuestionnaire(state, { expectedStateVersion: 3, questionnaire: { questions: [request.questionnaire] } }, sourceEntryId).state;
  assert.throws(() => recordRouteSelection(state, { expectedStateVersion: 3, selectionRequestId: request.id, sourceEntryId,
    questionnaire: { outcome: "answered", answers: [{ questionIndex: 0, question: request.questionnaire.question,
      kind: "option", answer: "routeB", selected: ["routeB"] }] } }), /unresolved DAG execution/);
});

test("first prompt is immutable Original Goal; later prompts are recorded updates", () => {
  const first = captureHumanPrompt(emptyGoalRunState(), "Goal: implement smoke test");
  const second = captureHumanPrompt(first.state, "Actually, I need online visual editing instead of local parsing.");
  assert.equal(second.state.goal.original, "Goal: implement smoke test");
  assert.equal(second.state.goal.current, "Goal: implement smoke test");
  assert.equal(second.id, "U1");
  assert.equal(explicitGoalChangeUpdates(second.state).length, 1);
  assert.match(buildGoalAnchor(second.state), /Original Goal preview.*Goal: implement smoke test/);
  assert.match(buildGoalAnchor(second.state), /Pending scope change U1/);
});

test("a conventions section is not duplicated into the runtime directive ledger", () => {
  const prompt = `Goal: build a reproducible TTS workflow.

# Restrictions
- NPU-first; do not assume a GPU.
- Do not replace the production voice before human A/B listening acceptance.

conventions:
1. 用 rg 不用 grep，用 fd 不用 find，用 amend 不用 python heredoc repl。
2. 不要每次都 cd；当前就在 cwd。`;
  const state = captureHumanPrompt(emptyGoalRunState(), prompt).state;
  assert.ok(state.sessionDirectives.some((item) => /NPU-first/.test(item.text)), "explicit restrictions remain part of Messages continuity");
  assert.ok(state.sessionDirectives.some((item) => /Do not replace the production voice/.test(item.text)));
  assert.ok(!state.sessionDirectives.some((item) => /用 rg|用 fd|amend 不用|每次都 cd|当前就在 cwd/.test(item.text)), "working conventions remain in the Human source instead of being duplicated as runtime rules");
  assert.equal(planningActivationSignal(prompt), null, "conventions do not accidentally surface planning tools");
  assert.deepEqual(availableCapabilities(state), [], "conventions do not surface acceptance/history/planning capabilities");
});

test("convention extraction does not swallow a following unheaded Human requirement", () => {
  const prompt = `Goal: implement a component.\n\nconventions:\n1. 用 rg 不用 grep。\n2. 不要每次 cd。\n\nDo not replace the production data.\n\nAcceptance criteria\n- Production data remains unchanged.`;
  const state = captureHumanPrompt(emptyGoalRunState(), prompt).state;
  assert.ok(state.sessionDirectives.some((item) => /Do not replace the production data/.test(item.text)), "the paragraph following the convention list is an actual restriction");
  assert.ok(!state.sessionDirectives.some((item) => /用 rg|每次 cd/.test(item.text)));
});

test("a quoted or fenced conventions example never swallows an actual planning instruction", () => {
  const prompt = `Goal: do two independent workstreams.\n\n\`\`\`text\nconventions:\n1. do not cd\n\`\`\`\n\nImplement multiple independent workstreams in stages.`;
  assert.ok(planningActivationSignal(prompt), "a code block is an example, not a section boundary hiding the actual Goal");
});

test("initial Goal prompt preserves explicit constraints and acceptance criteria before compaction", () => {
  const prompt = `Goal
Build a reliable TTS workflow.

Restrictions
- NPU-first; do not assume a GPU.
- Do not replace the production voice before Human A/B listening.
- Conclusions must cite evidence and references.

Acceptance criteria
- At least three candidates have real NPU synthesis records or reproducible failure records.
- The workflow can be replayed from a clean environment.
`;
  const result = captureHumanPrompt(emptyGoalRunState(), prompt);
  assert.equal(result.state.goal.original, prompt.trim());
  assert.equal(result.state.goal.current, prompt.trim(), "the raw initial prompt remains available as provenance");
  assert.deepEqual(result.state.goal.criteria.map((item) => item.text), [
    "At least three candidates have real NPU synthesis records or reproducible failure records.",
    "The workflow can be replayed from a clean environment.",
  ]);
  assert.ok(result.state.sessionDirectives.some((item) => /NPU-first/.test(item.text)));
  assert.ok(result.state.sessionDirectives.some((item) => /Do not replace the production voice/.test(item.text)));
  assert.ok(result.state.sessionDirectives.some((item) => /Conclusions must cite evidence/.test(item.text)));
  const anchor = buildGoalAnchor(result.state);
  assert.match(anchor, /Hard Human constraints/);
  assert.match(anchor, /At least three candidates/);
});

test("acceptance parser stops at trailing prose after a labelled list", () => {
  const state = captureHumanPrompt(emptyGoalRunState(), `Goal: ship feature

Acceptance criteria
- Criterion A passes.
- Criterion B passes.

You may consult excellent upstream projects if useful.`).state;
  assert.deepEqual(state.goal.criteria.map((item) => item.text), ["Criterion A passes.", "Criterion B passes."]);
});



test("one-shot review prompts are not persisted as session directives or convention signals", () => {
  let state = withGoal("Start the application so I can inspect it.");
  const review = captureHumanPrompt(state, "请复盘本轮 Compass 使用情况。不要修改代码或登记规则。");
  assert.equal(review.captured, true, "the request is retained as an event without becoming a persistent instruction");
  assert.equal(review.kind, "one_shot_meta");
  assert.equal(review.state.goal.updates.length, 0);
  assert.equal(review.state.sessionDirectives.length, 0);
  assert.equal(review.state.events.at(-1).kind, "human_meta_prompt");
  assert.ok(!availableCapabilities(review.state).includes("conventions"));
  const ordinary = captureHumanPrompt(review.state, "帮我总结这个模块的职责");
  assert.equal(ordinary.captured, true, "ordinary project requests must remain normal Goal updates");
  assert.equal(ordinary.state.goal.updates.length, 1);
});

test("invalid acceptance criteria leave the original pending Goal update untouched", () => {
  const state = captureHumanPrompt(withGoal(), "Actually, I need online visual editing instead of local parsing.").state;
  const update = state.goal.updates.find((item) => item.id === "U1");
  const before = structuredClone(update);
  assert.throws(() => applyGoalChange(state, { updateId: "U1", newGoal: "Implement the replacement", acceptanceCriteria: [" "] }), /acceptanceCriteria\[0\]/);
  assert.deepEqual(update, before);
});

test("only a recorded explicit scope update can change Current Goal, and the old plan is archived", () => {
  let state = withPlan(withGoal());
  state = captureHumanPrompt(state, "Actually, I need online visual editing instead of local parsing.").state;
  const result = applyGoalChange(state, { updateId: "U1", newGoal: "Implement online visual editing" });
  assert.equal(result.state.goal.original, "Create a reliable full-stack smoke test");
  assert.equal(result.state.goal.current, "Implement online visual editing");
  assert.equal(result.state.plan.tasks.length, 0);
  assert.equal(result.archivedTaskCount, 3);
  assert.equal(result.state.goalChanges.length, 1);
  assert.equal(explicitGoalChangeUpdates(result.state).length, 0, "an applied update cannot be replayed");
  assert.throws(() => applyGoalChange(state, { updateId: "U99", newGoal: "Something else" }), /not an explicit Goal\/scope change|expired/);
});


test("Human directives split Chinese sentence boundaries and deduplicate atomic constraints", () => {
  const first = captureHumanPrompt(withGoal("Goal: implement a smoke test"), "用 compass。不要用 grep。不要用 find。必须保留当前 Goal。", { source: "message_end", messageId: "directive-atomic-1" });
  const directives = first.state.sessionDirectives.map((item) => item.text);
  assert.ok(directives.some((text) => text === "用 compass"));
  assert.ok(directives.some((text) => text === "不要用 grep"));
  assert.ok(directives.some((text) => text === "不要用 find"));
  assert.ok(directives.some((text) => text === "必须保留当前 Goal"));
  const repeated = captureHumanPrompt(first.state, "用 compass。不要用 grep。不要用 find。必须保留当前 Goal。", { source: "message_end", messageId: "directive-atomic-2" });
  assert.equal(repeated.state.sessionDirectives.length, directives.length);
  assert.ok(repeated.state.sessionDirectives.every((item) => item.reaffirmations >= 1));
});

test("unambiguous declarative Goal changes apply deterministically and archive the old plan", () => {
  let state = withPlan(withGoal("Goal: finish current feature"));
  const changed = captureHumanPrompt(state, "那我换一个 goal，现在的 goal 就是把 pptx-forge 高质量交付");
  assert.equal(changed.kind, "goal_changed");
  assert.equal(changed.state.goal.original, "Goal: finish current feature");
  assert.equal(changed.state.goal.current, "把 pptx-forge 高质量交付");
  assert.equal(changed.state.plan.tasks.length, 0);
  assert.equal(changed.state.goalChanges[0].previousPlan.tasks.length, 3);
  assert.equal(explicitGoalChangeUpdates(changed.state).length, 0);
});


test("embedded Goal language in a long engineering prompt cannot silently replace the current Goal", () => {
  let state = defineAcceptanceCriteria(withGoal("Goal: fix eight OptiX integration issues"), acceptanceCriteria).state;
  state = withPlan(state);
  const priorPlanCount = state.plan.tasks.length;
  const priorCriteria = state.goal.criteria.map((item) => item.text);
  const prompt = `你自己 scout 那 4 个缺口，先比较现有证据和之前的方案，不要重做已经完成的工作。
\`\`\`markdown
# Goal
接入 auto_aisbench 插件
\`\`\`
现在有些是之前通过改 adapter 完成的，目标就是接入 auto_aisbench 插件，然后删除 adapter。
Constraint: 只允许修改 msmodeling/optix 和 Hub adapter 相关文件。
不要为了修一个问题改动无关的共享路径。`;
  const result = captureHumanPrompt(state, prompt, { source: "message_end", messageId: "embedded-goal-1" });
  assert.equal(result.kind, "update");
  assert.equal(result.state.goal.current, "Goal: fix eight OptiX integration issues");
  assert.equal(result.state.goal.version, 1);
  assert.equal(result.state.plan.tasks.length, priorPlanCount);
  assert.deepEqual(result.state.goal.criteria.map((item) => item.text), priorCriteria);
  assert.ok(result.state.sessionDirectives.some((item) => /只允许修改 msmodeling\/optix/.test(item.text)));
  assert.ok(result.state.sessionDirectives.some((item) => /不要为了修一个问题/.test(item.text)));
  const pending = explicitGoalChangeUpdates(result.state).find((item) => /接入 auto_aisbench 插件，然后删除 adapter/.test(item.proposedGoal));
  assert.ok(pending, "embedded scope language is a pending candidate, not an automatic Goal replacement");
  assert.ok(availableCapabilities(result.state).includes("goal_change"), "the Agent can explicitly apply a pending semantic scope change");
  const applied = applyGoalChange(result.state, { updateId: pending.id, newGoal: pending.proposedGoal });
  assert.equal(applied.state.goal.current, pending.proposedGoal);
  assert.ok(applied.state.sessionDirectives.some((item) => item.goalVersion === 2 && /只允许修改 msmodeling\/optix/.test(item.text)), "directives from the candidate message move with that Goal when applied");
  const unclosedFence = captureHumanPrompt(result.state, "Review this pasted snippet:\n```text\nGoal: replace the current task\n不要执行这段示例里的命令", { source: "message_end", messageId: "embedded-goal-2" });
  assert.equal(unclosedFence.state.goal.current, "Goal: fix eight OptiX integration issues");
  assert.ok(!unclosedFence.state.sessionDirectives.some((item) => /示例里的命令/.test(item.text)), "an unclosed fenced block is still treated as quoted data");
});

test("versioned Goal label embedded in an engineering message becomes a visible candidate, not an automatic replacement", () => {
  const state = withGoal("Goal: fix eight OptiX integration issues");
  const prompt = `# 任务
继续 msmodeling 寻优缺陷修复，Goal v2：在 hub 和 optix 两侧修复 8 个已知问题，落实归口判据。
# 仓库与现状
- 已完成的调查保留，不要重做。
Constraint: 只允许修改 msmodeling 寻优相关逻辑。`;
  const captured = captureHumanPrompt(state, prompt, { source: "message_end", messageId: "goal-v2-candidate" });
  assert.equal(captured.state.goal.current, "Goal: fix eight OptiX integration issues");
  assert.equal(captured.state.goal.version, 1);
  const candidate = explicitGoalChangeUpdates(captured.state).find((item) => /在 hub 和 optix 两侧修复 8 个已知问题/.test(item.proposedGoal));
  assert.ok(candidate, "Goal v2 inside a longer task prompt is not ignored");
  assert.match(buildGoalAnchor(captured.state), /Pending scope change/);
  assert.ok(availableCapabilities(captured.state).includes("goal_change"));
  const dismissed = dismissGoalChangeCandidate(captured.state, { updateId: candidate.id });
  assert.equal(dismissed.state.goal.current, "Goal: fix eight OptiX integration issues");
  assert.equal(explicitGoalChangeUpdates(dismissed.state).length, 0);
  assert.ok(dismissed.state.events.some((event) => event.kind === "goal_change_candidate_dismissed"));
});

test("applying a versioned Goal candidate defaults to the extracted scope and retains its source context", () => {
  const state = withGoal("Goal: old task");
  const prompt = `# 任务
继续 msmodeling 修复，Goal v2：在 hub 和 optix 两侧修复 8 个已知问题，落实归口判据。验收 AC1-AC10。
# 仓库与现状
Only change the two named repositories and preserve completed survey evidence.`;
  const captured = captureHumanPrompt(state, prompt, { source: "message_end", messageId: "goal-v2-source" });
  const candidate = explicitGoalChangeUpdates(captured.state)[0];
  assert.ok(candidate);
  const applied = applyGoalChange(captured.state, { updateId: candidate.id });
  assert.match(applied.state.goal.current, /在 hub 和 optix 两侧修复 8 个已知问题/);
  assert.equal(applied.state.goal.sourceUpdateId, candidate.id);
  assert.match(buildGoalAnchor(applied.state), /Current Goal source/);
  assert.match(buildGoalAnchor(applied.state), /Acceptance reference warning/);
  assert.match(buildGoalDetails(applied.state), /Human message that established Current Goal/);
});

test("explicit Goal replacement must be top-level and directive fragments stay atomic", () => {
  let state = withGoal("Goal: implement feature");
  state = captureHumanPrompt(state, "用 rg 不用 grep，用 fd 不用 find，不用每次都 cd，你当前就在 cwd", { source: "message_end", messageId: "rule-1" }).state;
  const first = state.sessionDirectives.map((item) => item.text);
  assert.ok(first.some((text) => /rg/.test(text)));
  assert.ok(first.some((text) => /fd/.test(text)));
  assert.ok(first.some((text) => /cd/.test(text)));
  assert.ok(first.length >= 3 && first.length <= 5, "one long message becomes a few actionable directives, not one clipped blob");
  state = captureHumanPrompt(state, "用 rg 不用 grep，用 fd 不用 find，不用每次都 cd，你当前就在 cwd", { source: "message_end", messageId: "rule-2" }).state;
  assert.ok(state.sessionDirectives.length <= first.length + 1, "repeated constraints are deduplicated instead of filling the directive ledger");
  assert.ok(state.sessionDirectives.some((item) => (item.reaffirmations ?? 1) >= 2));
});

test("ask-user-question choices are kept as authoritative decisions and included in the anchor", () => {
  let state = withGoal("Goal: deliver the feature");
  const captured = captureHumanDecision(state, {
    source: "ask_user_question", sourceEntryId: "entry-q1", sourceCallId: "q1",
    text: 'User has answered your questions: "Delivery"="Push origin/main only".',
  });
  assert.equal(captured.captured, true);
  assert.equal(captured.state.humanDecisions[0].goalVersion, 1);
  assert.match(buildGoalAnchor(captured.state), /Push origin\/main only/);
  const duplicate = captureHumanDecision(captured.state, {
    source: "ask_user_question", sourceEntryId: "entry-q1", sourceCallId: "different-provider-id", text: "duplicate",
  });
  assert.equal(duplicate.captured, true, "a different tool call in the same persisted assistant entry is a distinct Human decision");
});

test("structured questionnaire answers preserve choice semantics without storing rich preview payloads", () => {
  const state = withGoal("Goal: build the local development workflow");
  const captured = captureHumanDecision(state, {
    source: "ask_user_question",
    sourceEntryId: "entry-structured-q1",
    sourceCallId: "structured-q1",
    text: `User has answered your questions: "Frontend"="Local Vite". selected preview: ${"large-preview-body ".repeat(400)}`,
    details: {
      cancelled: false,
      answers: [
        {
          questionIndex: 0,
          question: "Where should the frontend run?",
          kind: "option",
          answer: "Local Vite",
          preview: "A large markdown mockup that should not be duplicated in GoalRun.",
          notes: "Keep HMR enabled.",
        },
      ],
    },
  });
  assert.equal(captured.captured, true);
  assert.deepEqual(captured.item.questionnaire, {
    outcome: "answered",
    answers: [{
      questionIndex: 0,
      question: "Where should the frontend run?",
      kind: "option",
      answer: "Local Vite",
      notes: "Keep HMR enabled.",
      hasPreview: true,
    }],
  });
  assert.match(captured.item.summary, /Where should the frontend run\? = Local Vite/);
  assert.match(buildGoalAnchor(captured.state), /Local Vite/);
  assert.match(buildGoalDetails(captured.state), /Keep HMR enabled/);
  assert.doesNotMatch(JSON.stringify(captured.state), /large-preview-body/);
  assert.equal(captured.state.events.at(-1).status, "answered");
});

test("partial questionnaire answers and declined questionnaires retain their distinct outcomes and notes", () => {
  const state = withGoal("Goal: choose a deployment approach");
  const partial = captureHumanDecision(state, {
    source: "ask_user_question",
    sourceEntryId: "entry-partial-q1",
    sourceCallId: "partial-q1",
    text: 'User has answered your questions: "Tunnel"="SSH". unanswered: "Port policy". global note: keep the host closed.',
    details: {
      cancelled: false,
      answers: [{ questionIndex: 0, question: "Tunnel?", kind: "option", answer: "SSH" }],
      unanswered: [1],
      globalNote: "Keep the host closed.",
    },
  });
  assert.equal(partial.item.questionnaire.outcome, "partial");
  assert.deepEqual(partial.item.questionnaire.unanswered, [1]);
  assert.equal(partial.item.questionnaire.globalNote, "Keep the host closed.");

  const declined = captureHumanDecision(partial.state, {
    source: "ask_user_question",
    sourceEntryId: "entry-declined-q1",
    sourceCallId: "declined-q1",
    text: "User declined to answer questions",
    details: { answers: [], cancelled: true, globalNote: "Ask again after the demo." },
  });
  assert.equal(declined.item.questionnaire.outcome, "declined");
  assert.equal(declined.item.questionnaire.globalNote, "Ask again after the demo.");
  assert.match(declined.item.summary, /Declined questionnaire/);
});

test("questionnaire UI and validation errors are events, not Human decisions", () => {
  const state = withGoal("Goal: select an execution route");
  const failed = recordHumanQuestionnaireFailure(state, {
    source: "ask_user_question",
    sourceEntryId: "entry-failed-q1",
    sourceCallId: "failed-q1",
    errorCode: "session_load_failed",
    reason: "The dialog module failed to import.",
  });
  assert.equal(failed.captured, true);
  assert.equal(failed.state.humanDecisions.length, 0);
  assert.equal(failed.state.events.at(-1).kind, "human_questionnaire_error");
  assert.equal(failed.state.events.at(-1).status, "session_load_failed");
  const duplicate = recordHumanQuestionnaireFailure(failed.state, {
    source: "ask_user_question", sourceEntryId: "entry-failed-q1", sourceCallId: "failed-q1", errorCode: "no_ui",
  });
  assert.equal(duplicate.captured, false);
  const mistakenDecision = captureHumanDecision(state, {
    source: "ask_user_question",
    sourceEntryId: "entry-failed-q2",
    sourceCallId: "failed-q2",
    text: "User declined to answer questions",
    details: { answers: [], cancelled: true, error: "no_ui" },
  });
  assert.equal(mistakenDecision.captured, false);
  assert.equal(mistakenDecision.kind, "questionnaire_error");
});

test("explicit Human work instructions persist separately from ordinary updates", () => {
  let state = withGoal("Goal: ship the feature");
  state = captureHumanPrompt(state, "用 rg 不用 grep，用 fd 不用 find，不用 cd，你当前就在 cwd").state;
  state = captureHumanPrompt(state, "The API health route is /healthz.").state;
  state = captureHumanPrompt(state, "The current tests use Vitest.").state;
  state = captureHumanPrompt(state, "Please inspect the backend config.").state;
  const anchor = buildGoalAnchor(state);
  assert.match(anchor, /Human preference S3/);
  assert.match(anchor, /不用 cd/);
});

test("material decisions and checkpoints work without a DAG", () => {
  let state = withGoal();
  state = recordDecision(state, { summary: "Do not reset shared DB", rationale: "No disposable test DB exists", evidence: "No test DB URL in config" }).state;
  state = recordCheckpoint(state, { summary: "Before API integration", ref: "git:abc123", evidence: "Baseline tests pass" }).state;
  assert.equal(state.decisions[0].id, "D1");
  assert.equal(state.checkpoints[0].id, "C1");
  assert.match(buildIssueReview(state, "API test fails"), /Do not reset shared DB/);
  assert.match(buildIssueReview(state, "API test fails"), /git:abc123/);
});

test("tool failures are on-demand trace, not automatically injected into the Goal anchor", () => {
  let state = withGoal();
  state = recordFailure(state, { tool: "bash", error: "command exited 1" });
  assert.doesNotMatch(buildGoalAnchor(state), /command exited 1/);
  assert.match(buildIssueReview(state, "should I change direction?"), /command exited 1/);
  assert.ok(availableCapabilities(state).includes("issue_review"));
});

test("reopening a prerequisite resets downstream dependents but preserves unrelated work", () => {
  let state = withPlan(withGoal());
  state = completeAndAssess(state, "api", "API inspected");
  state = completeAndAssess(state, "ui", "UI inspected");
  state = transitionTasks(state, "start", [{ id: "smoke" }], updateTasks).state;
  state = transitionTasks(state, "done", [{ id: "smoke", evidence: "Smoke passed" }], updateTasks).state;
  // Add an unrelated completed task to make preservation observable.
  state = revisePlanState(state, { acceptanceCriteria, tasks: [...tasks, { id: "docs", title: "Document command", acceptance: "Command is documented", dependsOn: [], writeScope: "docs" }], changeReason: "Documentation is a separate deliverable" }).state;
  state = approvePlan(state);
  state = transitionTasks(state, "start", [{ id: "docs" }], updateTasks).state;
  state = transitionTasks(state, "done", [{ id: "docs", evidence: "README command added" }], updateTasks).state;
  const result = transitionTasks(state, "reopen", [{ id: "api", reason: "New API evidence invalidates prior investigation" }], updateTasks);
  const byId = new Map(result.state.plan.tasks.map((task) => [task.id, task]));
  assert.equal(byId.get("api").status, "pending");
  assert.equal(byId.get("smoke").status, "pending");
  assert.equal(byId.get("ui").status, "done");
  assert.equal(byId.get("docs").status, "done");
});

test("DAG is optional for Goal continuity", () => {
  const state = withGoal();
  assert.equal(state.plan.tasks.length, 0);
  assert.match(buildGoalAnchor(state), /No DAG is active/);
  assert.deepEqual(availableCapabilities(state), [], "a simple Goal should not expose capability groups by default");
});

test("changing Goal archives old history by version without deleting evidence or leaking old directives", () => {
  let state = withPlan(withGoal());
  state = recordDecision(state, { summary: "Use local parser", rationale: "Initial scope", evidence: "Only local input requested" }).state;
  state = recordCheckpoint(state, { summary: "Before parser refactor", ref: "git:deadbeef" }).state;
  state = recordFailure(state, { tool: "bash", error: "old goal failed" });
  state = captureHumanPrompt(state, "Actually, I need online visual editing instead of local parsing.").state;
  const changed = applyGoalChange(state, { updateId: "U1", newGoal: "Implement online visual editing" }).state;
  assert.equal(changed.decisions.length, 1);
  assert.equal(changed.checkpoints.length, 1);
  assert.equal(changed.trace.failures.length, 1);
  assert.equal(changed.decisions[0].goalVersion, 1);
  assert.equal(changed.goal.version, 2);
  assert.equal(changed.goalChanges[0].decisions[0].summary, "Use local parser");
  assert.equal(changed.goalChanges[0].checkpoints[0].ref, "git:deadbeef");
  assert.doesNotMatch(buildGoalAnchor(changed), /Use local parser/);
  assert.doesNotMatch(buildIssueReview(changed, "new issue"), /old goal failed/);
});


test("GoalRun rejects obsolete schema versions instead of migrating or silently reinterpreting them", () => {
  assert.throws(() => normalizeGoalRunState({ schemaVersion: 6, goal: { original: "obsolete" }, plan: emptyDagState() }), /Unsupported.*schema/);
});

test("explicit Goal label updates current Goal and scopes old directives to the previous version", () => {
  let state = withGoal("Start the app");
  state = captureHumanPrompt(state, "用 rg，不要用 grep；本轮先不提交").state;
  const changed = captureHumanPrompt(state, "好，我来更新。目标：操作 c4916005012b879ab0c15ef03652eb6e 页面");
  assert.equal(changed.kind, "goal_changed");
  assert.equal(changed.state.goal.current, "操作 c4916005012b879ab0c15ef03652eb6e 页面");
  assert.equal(changed.state.goal.version, 2);
  assert.match(buildGoalAnchor(changed.state), /Current Goal v2/);
  assert.doesNotMatch(buildGoalAnchor(changed.state), /不要用 grep/);
  assert.equal(changed.state.sessionDirectives[0].goalVersion, 1);
  assert.ok(changed.state.events.some((event) => event.kind === "goal_changed"));
});

test("direct Goal replacement carries unquoted constraints into the new Goal version", () => {
  let state = withGoal("Goal: inspect the current implementation");
  state = captureHumanPrompt(state, "Goal: integrate the upstream plugin and remove the obsolete adapter\nConstraint: only change OptiX integration files.\n不要改动共享通用逻辑。").state;
  assert.equal(state.goal.version, 2);
  assert.equal(state.goal.current, "integrate the upstream plugin and remove the obsolete adapter");
  assert.ok(state.sessionDirectives.some((item) => item.goalVersion === 2 && /only change OptiX integration files/i.test(item.text)));
  assert.ok(state.sessionDirectives.some((item) => item.goalVersion === 2 && /不要改动共享通用逻辑/.test(item.text)));
  assert.doesNotMatch(buildGoalAnchor(state), /Human session directives.*Goal v1/);
});

test("direct Goal replacement captures explicitly labelled acceptance criteria and excludes the section from Current Goal", () => {
  const first = withGoal("Goal: inspect current implementation");
  const changed = captureHumanPrompt(first, `Goal: integrate upstream auto_aisbench plugin
Constraints:
- Only change OptiX integration files.
Acceptance criteria:
- The adapter is removed from the Hub path.
- Existing relevant tests pass.`);
  assert.equal(changed.kind, "goal_changed");
  assert.equal(changed.state.goal.current, "integrate upstream auto_aisbench plugin");
  assert.deepEqual(changed.state.goal.criteria.map((item) => item.text), [
    "The adapter is removed from the Hub path.",
    "Existing relevant tests pass.",
  ]);
  assert.ok(changed.state.sessionDirectives.some((item) => item.goalVersion === 2 && /Only change OptiX integration files/.test(item.text)));
});

test("mixed Human messages project directive clauses once and keep the remaining issue summary", () => {
  const captured = captureHumanPrompt(
    withGoal("Goal: repair the build"),
    "Use rg instead of grep. The actual blocker is that cargo build cannot find the linker; investigate the toolchain.",
  );
  const anchor = buildGoalAnchor(captured.state);
  assert.match(anchor, /Human preference S1: Use rg instead of grep/);
  assert.match(anchor, /Recent Human updates: U1: The actual blocker is that cargo build cannot find the linker/);
  assert.doesNotMatch(anchor, /Recent Human updates: U1: Use rg instead of grep/);
});

test("new evidence can explicitly supersede a prior decision without deleting its history", () => {
  let state = withGoal("Goal: integrate the plugin safely");
  state = recordDecision(state, { summary: "Delete the adapter", rationale: "Initial interpretation", evidence: "Observed old call path" }).state;
  const priorId = state.decisions.at(-1).id;
  const result = recordDecision(state, {
    summary: "Revert the compatibility commit instead",
    rationale: "New evidence shows the plugin replaces the placeholder before the base parser runs",
    evidence: "Call-order trace from the upstream plugin",
    supersedesDecisionIds: [priorId],
  });
  const prior = result.state.decisions.find((item) => item.id === priorId);
  assert.equal(prior.supersededBy, result.item.id);
  assert.deepEqual(result.item.supersedesDecisionIds, [priorId]);
  assert.deepEqual(result.impactedTaskIds, []);
  assert.ok(result.state.events.some((event) => event.kind === "decision_superseded" && event.ref === priorId));
  const anchor = buildGoalAnchor(result.state);
  assert.match(anchor, /Latest active decision D2/);
  assert.match(anchor, /supersedes D1/);
  assert.doesNotMatch(anchor, /Latest active decision D1/);
  assert.throws(() => recordDecision(result.state, { summary: "Bad stale correction", supersedesDecisionIds: ["D999"] }), /Unknown or stale decision IDs/);
});

test("stale task IDs in decisions return the current valid IDs", () => {
  const state = withPlan(withGoal());
  assert.throws(
    () => recordDecision(state, { summary: "Attach decision to a stale task", affectedTaskIds: ["renderer"] }),
    /Unknown affected task ids: renderer\. Current task IDs: api, ui, smoke\./,
  );
});

test("directive retention keeps hard constraints when the bounded ledger fills", () => {
  const preferences = Array.from({ length: 28 }, (_, i) => `Prefer tool-${i} when convenient`).join("。 ");
  const prompt = `Only modify msmodeling/optix integration files.。${preferences}`;
  const captured = captureHumanPrompt(withGoal("Goal: keep the integration stable"), prompt);
  assert.equal(captured.state.sessionDirectives.length, 25, "hard constraints have a separate retention budget from soft preferences");
  assert.ok(captured.state.sessionDirectives.some((item) => /Only modify msmodeling\/optix integration files/.test(item.text)));
});

test("explicit hard constraints survive many later preferences and remain visible in the compact anchor", () => {
  const prompt = `Goal: enforce the dispatch safety boundary

Restrictions
- Yellow-zone tokens are read-only and cannot push.
- Never inherit daemon credentials into task processes.
- PID identity must be checked before killing a process.
- Never claim a process was killed unless evidence confirms it.
- Other layers must not silently clamp values.
- A run without finished must be hard-killed on restart.
- Do not return credentials to task subprocesses.
- Results return to blue only through the fixed daemon endpoint.
- The yellow zone must leave no process residue.
- Keep the two tokens distinct.
- Use the exact configured outbound route only.`;
  let state = captureHumanPrompt(emptyGoalRunState(), prompt).state;
  for (let index = 0; index < 30; index += 1) {
    state = captureHumanPrompt(state, `Prefer compact output format ${index} when convenient.`).state;
  }
  for (let index = 0; index < 5; index += 1) {
    state = captureHumanPrompt(state, `Never print temporary debug token ${index} in the final output.`).state;
  }
  const retainedHard = state.sessionDirectives.filter((item) => item.hard === true);
  assert.equal(retainedHard.length, 16, "hard constraints are retained separately from soft preferences");
  assert.equal(retainedHard.filter((item) => item.pinned === true).length, 11, "explicit restriction-section clauses remain pinned");
  const anchor = buildGoalAnchor(state);
  for (const phrase of [
    "tokens are read-only",
    "Never inherit daemon credentials",
    "PID identity must be checked",
    "Never claim a process was killed",
    "must not silently clamp",
    "must be hard-killed",
    "Do not return credentials",
    "fixed daemon endp",
    "no process residue",
    "tokens distinct",
    "exact configured outbound route",
  ]) assert.match(anchor, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(anchor.length <= 2400, `compact anchor should remain bounded, got ${anchor.length} chars`);
  const details = buildGoalDetails(state);
  assert.match(details, /Hard Human constraints \(full retained text/);
  assert.match(details, /exact configured outbound route/);
});

test("Chinese 硬性限制 headings pin every safety clause before later preferences", () => {
  const prompt = `Goal: repair the dispatch safety boundary

硬性限制
- 黄区不得 git push。
- 任务子进程不得继承 daemon 凭据。
- 其他层不得静默 clamp。
- PID 复用时必须先验证进程身份。

当前状态：正在修复回传路径。`;
  let state = captureHumanPrompt(emptyGoalRunState(), prompt).state;
  const pinned = state.sessionDirectives.filter((item) => item.pinned === true);
  assert.equal(pinned.length, 4);
  for (let i = 0; i < 8; i += 1) state = captureHumanPrompt(state, `Prefer short status output ${i} when convenient.`).state;
  const anchor = buildGoalAnchor(state);
  for (const phrase of ["黄区不得 git push", "不得继承 daemon 凭据", "不得静默 clamp", "必须先验证进程身份"]) assert.ok(anchor.includes(phrase), `missing pinned clause: ${phrase}`);
});

test("numbered Goal requirements pin explicit hard clauses but not ordinary workflow steps", () => {
  const prompt = `Goal: improve the dispatcher
1. Only modify the dispatcher and its tests.
2. Never persist the token to disk.
3. First inspect the current code.
4. Then implement the smallest useful change.`;
  const state = captureHumanPrompt(emptyGoalRunState(), prompt).state;
  const pinnedText = state.sessionDirectives.filter((item) => item.pinned).map((item) => item.text);
  assert.ok(pinnedText.some((item) => /Only modify the dispatcher/.test(item)));
  assert.ok(pinnedText.some((item) => /Never persist the token/.test(item)));
  assert.ok(!pinnedText.some((item) => /First inspect the current code/.test(item)));
  assert.ok(!pinnedText.some((item) => /Then implement the smallest/.test(item)));
});

test("ready pending tasks can be completed directly, but dependency gates still apply", () => {
  const state = withPlan(withGoal());
  const completed = transitionTasks(state, "done", [{ id: "api", evidence: "Read route definitions and verified the health handler." }], updateTasks);
  assert.deepEqual(completed.completedWithoutStart, ["api"]);
  assert.equal(completed.state.plan.tasks.find((task) => task.id === "api").status, "done");
  assert.throws(
    () => transitionTasks(state, "done", [{ id: "smoke", evidence: "Smoke output exists." }], updateTasks),
    /pending and not ready; dependencies unfinished or not semantically checked: api, ui/,
  );
});

test("DAG progression requires a correlated exact approval; partial and custom answers do not approve", () => {
  let state = revisePlanState(withGoal(), { acceptanceCriteria, tasks }).state;
  const request = state.plan.approvalRequest;
  assert.equal(request.question, "Approve this exact Goal DAG for execution?");
  const approvalPreview = request.questionnaire.options[0].preview;
  assert.match(approvalPreview, /executor=parent/);
  assert.match(approvalPreview, /output=/);
  assert.match(approvalPreview, /writeScope=src\/smoke/);
  assert.match(approvalPreview, /API request returns expected data/);
  assert.equal(dagApprovalStatus(state).approved, false);
  assert.throws(() => transitionTasks(state, "start", [{ id: "api" }], updateTasks), /no current correlated Human approval/);
  assert.equal(state.plan.tasks[0].status, "pending", "rejected progression does not mutate state");

  const callId = "questionnaire-call-1";
  const alteredQuestionnaire = approvalInput(request);
  alteredQuestionnaire.questions[0].options[0].description += " altered";
  assert.equal(bindDagApprovalQuestionnaire(state, alteredQuestionnaire, "entry-questionnaire-call-1", callId).bound, false);
  for (const alter of [
    (input) => { input.questions[0].options[0].preview += " altered"; },
    (input) => { input.questions[0].multiSelect = true; },
    (input) => { input.questions[0].header += " altered"; },
  ]) {
    const altered = approvalInput(request);
    alter(altered);
    assert.equal(bindDagApprovalQuestionnaire(state, altered, "entry-questionnaire-call-1", callId).bound, false);
  }
  const bound = bindDagApprovalQuestionnaire(state, approvalInput(request), "entry-questionnaire-call-1", callId);
  assert.equal(bound.bound, true);
  const unrelated = captureHumanDecision(bound.state, { sourceCallId: "wrong-call", details: { answers: [{ questionIndex: 0, question: request.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION }] } }).state;
  assert.equal(dagApprovalStatus(unrelated).approved, false, "unrelated questionnaire cannot authorize the DAG");

  const partialBound = bindDagApprovalQuestionnaire(state, approvalInput(request), "entry-questionnaire-call-1", callId);
  const partial = captureHumanDecision(partialBound.state, { sourceEntryId: "entry-questionnaire-call-1", sourceCallId: callId, details: { unanswered: [0], answers: [] } }).state;
  assert.equal(dagApprovalStatus(partial).approved, false, "partial response does not approve");

  const qualifiedBound = bindDagApprovalQuestionnaire(state, approvalInput(request), "entry-qualified", "reused-provider-id");
  const qualified = captureHumanDecision(qualifiedBound.state, { sourceEntryId: "entry-qualified", sourceCallId: "reused-provider-id", details: { answers: [{ questionIndex: 0, question: request.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, notes: "Only after removing task smoke." }], globalNote: "Do not execute until the API is reviewed." } }).state;
  assert.equal(dagApprovalStatus(qualified).approved, false, "conditional notes withhold authorization");

  const renewed = renewDagApprovalRequest(partial).state;
  const renewedRequest = renewed.plan.approvalRequest;
  const fresh = bindDagApprovalQuestionnaire(renewed, approvalInput(renewedRequest), "entry-fresh", "reused-provider-id");
  const freshDecision = captureHumanDecision(fresh.state, { sourceEntryId: "entry-fresh", sourceCallId: "reused-provider-id", details: { answers: [{ questionIndex: 0, question: renewedRequest.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION] }] } });
  assert.equal(dagApprovalStatus(freshDecision.state).approved, true, "renewed exact approval remains current despite reused provider call ID");
  assert.equal(freshDecision.state.humanDecisions.length, 2, "distinct persisted exchanges sharing a provider ID are both retained");
  const duplicate = captureHumanDecision(freshDecision.state, { sourceEntryId: "entry-fresh", sourceCallId: "different-provider-id", details: { answers: [{ questionIndex: 0, question: renewedRequest.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION }] } });
  assert.notEqual(duplicate.kind, "duplicate", "a second tool call in the same persisted entry remains a separate decision");

  const revised = revisePlanState(state, { acceptanceCriteria, tasks: tasks.map((task) => task.id === "api" ? { ...task, acceptance: "API route and health semantics are documented with readiness evidence" } : task) }).state;
  assert.notEqual(revised.plan.approvalRequest.id, request.id, "material revision gets a new approval identity");
  assert.equal(dagApprovalStatus(revised).approved, false);
});

test("task completion is separate from version-bound semantic assessment and unresolved caveats block dependencies", () => {
  let state = withPlan(withGoal());
  state = transitionTasks(state, "done", [{ id: "api", evidence: "API route read and health behavior recorded." }], updateTasks).state;
  assert.equal(state.plan.tasks.find((task) => task.id === "api").assessment, null);
  assert.equal(state.plan.tasks.find((task) => task.id === "smoke").status, "pending");
  assert.throws(() => recordTaskAssessment(state, {
    taskId: "api", status: "pass", evidence: "The route is correct.", caveats: [], unresolvedCaveats: ["Readiness semantics remain unknown."],
  }), /cannot pass with unresolved caveats/);
  state = recordTaskAssessment(state, { taskId: "api", status: "inconclusive", evidence: "Liveness only; readiness remains unknown.", caveats: ["Health endpoint checks liveness."], unresolvedCaveats: ["Readiness not checked."] }).state;
  assert.deepEqual(readyTasks(state.plan).map((task) => task.id), ["ui"], "inconclusive prerequisite does not unlock dependents");
  state = recordTaskAssessment(state, { taskId: "api", status: "pass", evidence: "Additional evidence confirms the approved acceptance criterion.", caveats: [], unresolvedCaveats: [] }).state;
  assert.ok(state.plan.tasks.find((task) => task.id === "api").assessment.planRevision === state.plan.revision);
});

test("replanning invalidation clears descendant assessments before rerun", () => {
  const chain = [
    { id: "a", title: "A", acceptance: "A has evidence", dependsOn: [], writeScope: "read-only" },
    { id: "b", title: "B", acceptance: "B has evidence", dependsOn: ["a"], writeScope: "read-only" },
    { id: "c", title: "C", acceptance: "C has evidence", dependsOn: ["b"], writeScope: "read-only" },
  ];
  let state = revisePlanState(withGoal(), { acceptanceCriteria: ["All chain nodes pass"], tasks: chain }).state;
  state = approvePlan(state);
  for (const id of ["a", "b", "c"]) state = completeAndAssess(state, id, `Original execution evidence for ${id}.`);
  state = revisePlanState(state, { acceptanceCriteria: ["All chain nodes pass"], tasks: chain.map((task) => task.id === "a" ? { ...task, acceptance: "A has new evidence" } : task) }).state;
  assert.equal(state.plan.tasks.find((task) => task.id === "b").assessment, null);
  assert.equal(state.plan.tasks.find((task) => task.id === "c").assessment, null);
  state = approvePlan(state);
  state = completeAndAssess(state, "a", "New A execution evidence.");
  assert.deepEqual(readyTasks(state.plan).map((task) => task.id), ["b"]);
  state = transitionTasks(state, "done", [{ id: "b", evidence: "B rerun evidence." }], updateTasks).state;
  assert.deepEqual(readyTasks(state.plan).map((task) => task.id), [], "B cannot unlock C before fresh assessment");
  state = recordTaskAssessment(state, { taskId: "b", status: "pass", evidence: "Fresh B assessment after rerun.", caveats: [], unresolvedCaveats: [] }).state;
  assert.deepEqual(readyTasks(state.plan).map((task) => task.id), ["c"]);
});

test("ordinary task status updates preserve approval while material Human constraints invalidate it", () => {
  let state = withPlan(withGoal());
  assert.equal(dagApprovalStatus(state).approved, true);
  state = transitionTasks(state, "start", [{ id: "api" }], updateTasks).state;
  assert.equal(dagApprovalStatus(state).approved, true);
  state = captureHumanPrompt(state, "Please keep the API read-only during this work.").state;
  assert.equal(dagApprovalStatus(state).approved, false);
  assert.throws(() => transitionTasks(state, "done", [{ id: "api", evidence: "API reviewed." }], updateTasks), /no current correlated Human approval/);
});

test("acceptance evidence accepts realistic bounded evidence and survives state normalization", () => {
  let state = defineAcceptanceCriteria(withGoal(), ["The reproducible acceptance artifact exists."]).state;
  const evidence = `artifact=out/acceptance.json; result=PASS; ${"observed output and command provenance ".repeat(40)}`.slice(0, 1682);
  state = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence }).state;
  const normalized = normalizeGoalRunState(state);
  assert.equal(normalized.goal.criteria[0].evidence.length, evidence.trim().length);
  assert.equal(normalized.goal.criteria[0].evidence, evidence.trim());
});

test("reported acceptance does not hide a blocked Goal task", () => {
  let state = withPlan(withGoal());
  state = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence: "API route and health handler verified." }).state;
  state = recordAcceptanceResult(state, { criterionId: "AC2", status: "reported_pass", evidence: "Started processes are cleaned up in the exercised path." }).state;
  state = transitionTasks(state, "block", [{ id: "smoke", reason: "External service credentials are not available." }], updateTasks).state;
  const anchor = buildGoalAnchor(state);
  assert.match(anchor, /task\(s\) remain blocked \(smoke\)/);
  assert.match(summarizePlanStatus(state), /stateVersion:/);
  assert.match(summarizePlanStatus(state), /Outcome caveat:/);
  assert.match(buildStateSnapshot(state).goalOutcomeCaveat, /smoke/);
});

test("Goal anchor prioritizes hard scope directives over newer low-priority preferences", () => {
  const state = withGoal("Goal: improve the integration");
  state.sessionDirectives = [
    { id: "S1", goalVersion: 1, text: "Only modify msmodeling/optix integration files.", at: "2026-10-20T00:00:00.000Z", reaffirmations: 1 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `S${i + 2}`, goalVersion: 1, text: `Prefer ${["rg", "fd", "amend", "short scripts", "small patches", "focused tests", "clear logs", "compact results"][i]} when convenient.`, at: `2026-10-24T00:0${i}:00.000Z`, reaffirmations: 1 })),
  ];
  const anchor = buildGoalAnchor(state);
  assert.match(anchor, /Only modify msmodeling\/optix integration files/, "hard scope constraints outrank newer low-priority preferences");
});

test("acceptance is explicit, evidence-bearing, and never calls an Agent report independently verified", () => {
  let state = withGoal("Ship a reliable feature");
  const defined = defineAcceptanceCriteria(state, ["Unit tests pass", "Smoke test reaches the backend"]);
  state = defined.state;
  assert.equal(acceptanceStatus(state).status, "active");
  const first = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence: "npm test: 42 passed" });
  state = first.state;
  assert.equal(acceptanceStatus(state).status, "active");
  const second = recordAcceptanceResult(state, { criterionId: "AC2", status: "reported_pass", evidence: "Smoke output returned HTTP 200" });
  state = second.state;
  assert.equal(acceptanceStatus(state).status, "reported_satisfied");
  const beforeDuplicate = state.eventSeq;
  const duplicate = recordAcceptanceResult(state, { criterionId: "AC2", status: "reported_pass", evidence: "Smoke output returned HTTP 200" });
  assert.equal(duplicate.changed, false, "repeating identical acceptance evidence is idempotent");
  assert.equal(duplicate.state.eventSeq, beforeDuplicate, "a no-op retry must not create a fake event");
  assert.match(buildGoalAnchor(state), /not an independent verifier result/);
  assert.equal(buildRecentEvents(state).filter((event) => event.kind === "acceptance_result").length, 2);
});

test("Goal criteria and DAG task completion remain separate states", () => {
  let state = withPlan(withGoal());
  state = completeAndAssess(state, "api", "API inspected");
  state = completeAndAssess(state, "ui", "UI inspected");
  state = transitionTasks(state, "start", [{ id: "smoke" }], updateTasks).state;
  state = transitionTasks(state, "done", [{ id: "smoke", evidence: "Implementation exists" }], updateTasks).state;
  assert.equal(state.plan.tasks.every((task) => task.status === "done"), true);
  assert.equal(acceptanceStatus(state).status, "active");
  assert.match(buildGoalAnchor(state), /Do not equate task closure with Goal completion/);
});


test("Goal details do not echo identical Goal text as update, directive, and event history", () => {
  const prompt = "Goal: preserve public API and produce a tested build";
  let state = withGoal(prompt);
  state = captureHumanPrompt(state, prompt, { source: "message_end", messageId: "user-1" }).state;
  state.sessionDirectives.push({ id: "S1", goalVersion: 1, text: prompt, at: new Date().toISOString() });
  const details = buildGoalDetails(state);
  assert.equal((details.match(/preserve public API and produce a tested build/g) ?? []).length, 1);
  assert.doesNotMatch(details, /Recent structured events/);
  assert.ok(details.length < 1000);
  assert.equal(buildRecentEvents(state).filter((event) => event.kind === "human_update").length, 0);
});

test("initial Goal is not duplicated as a session directive", () => {
  const longGoal = `Goal: You must preserve the public API and use rg for repository search. ${"Additional acceptance constraint. ".repeat(20)}`;
  const state = withGoal(longGoal);
  assert.equal(state.sessionDirectives.length, 0);
  assert.match(buildGoalAnchor(state), /Original Goal preview/);
  assert.match(buildGoalAnchor(state), /retrieve Goal details for the retained original text/);
  assert.match(buildGoalDetails(state), /Additional acceptance constraint/,
    "the full retained Goal remains available through the focused details tool");
  assert.equal(buildStateSnapshot(state).goal.currentTruncated, true);
});

test("route review signal requires a repeated failure signature, not merely several unrelated errors", async () => {
  const { shouldSurfaceIssueReview } = await import("../src/goal-run.mjs");
  let state = withGoal();
  state = recordFailure(state, { tool: "bash", error: "file not found: /tmp/a" });
  state = recordFailure(state, { tool: "read", error: "permission denied" });
  state = recordFailure(state, { tool: "edit", error: "invalid patch context" });
  assert.equal(shouldSurfaceIssueReview(state), false);
  state = recordFailure(state, { tool: "bash", error: "command exited 1" });
  state = recordFailure(state, { tool: "bash", error: "command exited 2" });
  assert.equal(shouldSurfaceIssueReview(state), true);
});


test("compact state snapshot returns a cursor and only new current-Goal events", () => {
  let state = withGoal("Goal: implement API smoke test");
  const initial = buildStateSnapshot(state);
  assert.equal(initial.v, 6);
  assert.equal(initial.goal.version, 1);
  assert.equal(initial.goal.currentTruncated, false);
  assert.equal(initial.plan, null);
  assert.equal(initial.delta.hasNewEvents, true);
  const cursor = initial.cursor;
  state = recordDecision(state, { summary: "Use existing health endpoint", rationale: "Avoid duplicate route", evidence: "src/api/health.ts" }).state;
  const delta = buildStateSnapshot(state, cursor);
  assert.equal(delta.delta.events.length, 1);
  assert.equal(delta.delta.events[0].kind, "decision_recorded");
  assert.equal(delta.delta.events[0].summary, "Use existing health endpoint");
  const unchanged = buildStateSnapshot(state, delta.cursor);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.delta, undefined);
  assert.ok(JSON.stringify(unchanged).length < 220, "unchanged cursor response is only a small revision envelope");
});

test("composite state cursor detects revision changes even when event sequence did not change", () => {
  let state = withGoal("Goal: cursor includes revision and event sequence");
  const first = buildStateSnapshot(state);
  state.stateRevision += 1; // e.g. a persisted state/trace update without a user-facing event
  const changed = buildStateSnapshot(state, first.cursor);
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.delta.stateChanged, true);
  assert.equal(changed.delta.hasNewEvents, false);
  assert.notEqual(changed.cursor, first.cursor);
});

test("compact state reports a history gap and recovers with a bounded current snapshot", () => {
  let state = withGoal("Goal: preserve event history bounds");
  const oldCursor = "R0-E0";
  for (let i = 0; i < 100; i++) state = recordDecision(state, { summary: `Decision ${i}`, rationale: "test", evidence: `e${i}` }).state;
  const snapshot = buildStateSnapshot(state, oldCursor);
  assert.equal(snapshot.delta.historyGap, true);
  assert.ok(snapshot.delta.events.length <= 8);
  assert.ok(snapshot.delta.omitted > 0);
  assert.equal(snapshot.delta.cursorAhead, false);
});

test("state snapshot never leaks previous-Goal events into the active delta", () => {
  let state = withGoal("Goal: local parser");
  state = recordDecision(state, { summary: "Use local parser", rationale: "initial scope" }).state;
  const beforeChange = buildStateSnapshot(state).cursor;
  state = captureHumanPrompt(state, "Goal: online visual editing instead").state;
  const afterChange = buildStateSnapshot(state, beforeChange);
  assert.equal(afterChange.goal.version, 2);
  assert.ok(afterChange.delta.events.some((event) => event.kind === "goal_changed"));
  assert.ok(!afterChange.delta.events.some((event) => event.summary.includes("Use local parser")));
});

test("triage accepts current event references, deduplicates unchanged reviews, and reruns after new evidence", () => {
  let state = withGoal("Goal: fix API smoke tests");
  state = recordFailure(state, { tool: "bash", error: "test command failed with exit code 1" });
  const event = state.events.at(-1);
  const first = triageIssue(state, { evidenceRefs: [event.id] });
  assert.equal(first.duplicate, false);
  assert.match(first.review, new RegExp(event.id));
  const duplicate = triageIssue(first.state, { evidenceRefs: [event.id] });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.item.id, first.item.id);
  assert.match(duplicate.summary, /Route review/);
  const changed = recordFailure(first.state, { tool: "bash", error: "same test failed again" });
  const rerun = triageIssue(changed, { evidenceRefs: [event.id] });
  assert.equal(rerun.duplicate, false, "new failure event invalidates the old triage fingerprint");
});

test("triage rejects unknown and previous-Goal evidence references without changing state", () => {
  let state = withGoal("Goal: original");
  state = recordFailure(state, { tool: "bash", error: "old failure" });
  const oldEvent = state.events.at(-1).id;
  state = captureHumanPrompt(state, "Goal: new goal").state;
  assert.throws(() => triageIssue(state, { evidenceRefs: [oldEvent] }), /belongs to Goal v1, not current Goal v2/);
  assert.throws(() => triageIssue(state, { evidenceRefs: ["E999"] }), /not in retained history/);
  assert.throws(() => triageIssue(state, {}), /Provide a concise issue/);
});


test("recovered trace entries become cursor-addressable events without duplicates", () => {
  let state = withGoal("Goal: recover tool trace");
  const oldCursor = buildStateSnapshot(state).cursor;
  const failure = { at: new Date().toISOString(), goalVersion: 1, tool: "bash", error: "recovered failure" };
  state = mergeTrace(state, [{ kind: "failure", item: failure }]);
  const delta = buildStateSnapshot(state, oldCursor);
  assert.ok(delta.delta.events.some((event) => event.kind === "tool_failure" && event.summary === "recovered failure"));
  const once = state.events.filter((event) => event.kind === "tool_failure" && event.summary === "recovered failure").length;
  state = mergeTrace(state, [{ kind: "failure", item: failure }]);
  const twice = state.events.filter((event) => event.kind === "tool_failure" && event.summary === "recovered failure").length;
  assert.equal(twice, once);
});


test("state cursor ahead is explicit and still returns a bounded recovery snapshot", () => {
  let state = withGoal("Goal: cursor validation");
  state = recordDecision(state, { summary: "A material choice", rationale: "test" }).state;
  const snapshot = buildStateSnapshot(state, "R999-E999");
  assert.equal(snapshot.delta.cursorAhead, true);
  assert.equal(snapshot.delta.hasNewEvents, true);
  assert.ok(snapshot.delta.events.some((event) => event.kind === "decision_recorded"));
  assert.ok(snapshot.delta.omitted >= 0);
});

test("Goal references to acceptance ID ranges are not treated as defined criteria", () => {
  const state = withGoal("Goal: repair OptiX. Acceptance AC1-AC10 must be satisfied.");
  const anchor = buildGoalAnchor(state);
  assert.match(anchor, /Acceptance reference warning/);
  assert.equal(acceptanceStatus(state).status, "criteria_not_defined");
  const snapshot = buildStateSnapshot(state);
  assert.equal(snapshot.acceptance.referencedRangeWithoutDefinitions, true);
});

test("acceptance range warning detects a mismatch even when unrelated criteria exist", () => {
  const state = withGoal("Goal: repair. Acceptance AC1-AC10 must be satisfied.");
  state.goal.nextAcceptanceNumber = 7;
  defineAcceptanceCriteria(state, ["criterion seven", "criterion eight", "criterion nine", "criterion ten", "criterion eleven", "criterion twelve"]);
  const anchor = buildGoalAnchor(state);
  assert.match(anchor, /Acceptance reference warning/);
  assert.match(anchor, /Missing IDs: AC1, AC2, AC3, AC4, AC5, AC6/);
  assert.equal(buildStateSnapshot(state).acceptance.referenceMismatch.range, "AC1-AC10");
});

test("capture ledger stores fingerprints, while a long current-Goal source survives later updates", () => {
  let state = withGoal("Goal: initial target");
  const filler = `Context note ${"retain provenance without duplicating raw prompts ".repeat(42)}\n`;
  const source = `# Task\nContinue integration work, Goal v2: deliver the adapter-free OptiX flow.\n${filler}\nAcceptance criteria\n- The adapter-free path has a focused integration test.\n- The documented CLI path works from a clean checkout.`;
  const captured = captureHumanPrompt(state, source, { source: "message_end", messageId: "long-goal-source" });
  const candidate = explicitGoalChangeUpdates(captured.state)[0];
  assert.ok(candidate);
  assert.ok(candidate.sourceText.length > 1800, "pending candidate keeps the bounded full source, not only the 1800-char update preview");
  const applied = applyGoalChange(captured.state, { updateId: candidate.id });
  state = applied.state;
  assert.deepEqual(state.goal.criteria.map((item) => item.text), [
    "The adapter-free path has a focused integration test.",
    "The documented CLI path works from a clean checkout.",
  ], "acceptance criteria after the short update preview are still parsed from the source message");
  assert.equal(state.goal.sourceUpdateText, source);
  assert.ok(state.captureLedger.every((item) => !Object.hasOwn(item, "text")), "duplicate-detection ledger stores fingerprints, not raw prompt bodies");
  for (let index = 0; index < 14; index++) {
    state = captureHumanPrompt(state, `Progress update ${index}: reviewed one additional implementation detail.`).state;
  }
  assert.ok(state.goal.updates.some((item) => item.id === candidate.id), "the current Goal source update remains addressable beyond the recent-update window");
  assert.match(buildGoalDetails(state), /The adapter-free path has a focused integration test/);
  assert.ok(state.captureLedger.every((item) => item.preview.length <= 140));
});

test("Goal anchor warns when Subagents are registered but not model-visible", () => {
  const state = withGoal("Goal: inspect four independent code paths");
  const anchor = buildGoalAnchor(state, 2200, { subagents: { registered: true, active: false } });
  assert.match(anchor, /registered but inactive in the Pi\/user toolset/);
  assert.match(anchor, /Compass will not force-enable them/);
});

test("triage accepts bounded longer issue context without schema-retry churn and marks its preview", () => {
  const state = withGoal("Goal: concise tool schema");
  const result = triageIssue(state, { issue: `Observed failure: ${"context ".repeat(60)}` });
  assert.equal(result.issueTruncated, true);
  assert.equal(result.item.issueTruncated, true);
  assert.ok(result.item.issue.length <= 240);
  assert.match(result.review, /Issue preview only/);
  assert.throws(() => triageIssue(state, { issue: "x".repeat(4001) }), /at most 4000 characters/);
});


test("Goal outcome projection never upgrades Agent-reported acceptance to independent verification", () => {
  let state = withGoal("Goal: ship a reliable feature");
  assert.equal(goalOutcomeStatus(state).status, "not_assessed");
  state = defineAcceptanceCriteria(state, ["Build succeeds", "User-visible flow works"]).state;
  state = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence: "npm test exited 0" }).state;
  state = recordAcceptanceResult(state, { criterionId: "AC2", status: "reported_pass", evidence: "Observed expected screen" }).state;
  assert.equal(goalOutcomeStatus(state).status, "agent_reported_satisfied");
  assert.equal(goalOutcomeStatus(state).independentlyVerified, false);
  state = withPlan(state);
  state = transitionTasks(state, "block", [{ id: "smoke", reason: "External service unavailable" }], updateTasks).state;
  assert.equal(goalOutcomeStatus(state).status, "blocked");
  assert.deepEqual(goalOutcomeStatus(state).blockedTaskIds, ["smoke"]);
});

test("Goal outcome projection distinguishes incomplete and failed acceptance", () => {
  let state = defineAcceptanceCriteria(withGoal("Goal: ship a feature"), ["Build succeeds", "Runtime behavior is correct"]).state;
  state = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence: "Build exited 0" }).state;
  assert.equal(goalOutcomeStatus(state).status, "incomplete");
  state = recordAcceptanceResult(state, { criterionId: "AC2", status: "failed", evidence: "Runtime returned the wrong result" }).state;
  assert.equal(goalOutcomeStatus(state).status, "failed");
  assert.deepEqual(goalOutcomeStatus(state).failedCriterionIds, ["AC2"]);
  assert.equal(goalOutcomeStatus(emptyGoalRunState()).status, "no_goal");
});

test("capability availability is state-derived and does not expose irrelevant groups for a simple Goal", () => {
  assert.deepEqual(availableCapabilities(withGoal("Goal: fix one typo in one file")), []);
  const complex = withGoal("Goal: coordinate multiple independent workstreams; define acceptance criteria and preserve decision checkpoints.");
  assert.deepEqual(availableCapabilities(complex), ["planning", "acceptance", "history"]);
  const detailed = captureHumanPrompt(complex, "Please show the full original prompt details.").state;
  assert.ok(availableCapabilities(detailed).includes("goal_details"));
  const failed = recordFailure(complex, { tool: "bash", error: "test failed", at: "2026-10-27T00:00:00.000Z" });
  assert.ok(availableCapabilities(failed).includes("issue_review"));
  assert.ok(!availableCapabilities(failed).includes("conventions"));
});

test("planning activation recognizes explicit multi-part Goals but ignores examples and simple Goals", () => {
  assert.match(planningActivationSignal("Goal: harden dispatch. 1. Restrict the token. 2. Add a fixed return path. 3. Test recovery."), /numbered actionable/);
  assert.match(planningActivationSignal("Goal: coordinate multiple independent workstreams"), /multi-stage\/workstream/);
  assert.equal(planningActivationSignal("Goal: fix one typo in a single file"), null);
  assert.equal(planningActivationSignal("Goal: analyze incident. 1. Phenomenon: the service failed. 2. Root cause: a timeout. 3. Evidence: logs show 503. 4. Impact: one request failed."), null, "numbered diagnostic headings are not implementation plans");
  assert.match(planningActivationSignal("Goal: harden dispatch. 1. Restrict token permissions. 2. Add a fixed return path. 3. Test restart recovery."), /numbered actionable/);
  assert.equal(planningActivationSignal("Goal: fix one thing\n```text\n1. multi-stage example\n2. another phase\n```"), null);
  assert.equal(planningActivationSignal("Goal: fix one thing\n> 1. example\n> 2. another example"), null);
  assert.equal(planningActivationSignal("Goal: fix one thing; ignore `1. multi-stage` and `2. another phase`"), null);
  assert.equal(planningActivationSignal('Goal: fix one thing; the quoted example "multi-stage workstreams" is not an instruction.'), null);
  assert.equal(planningActivationSignal('Goal: fix one thing; ignore "1. Implement A. 2. Build B." as an example.'), null);
});

test("repeated failure anchor includes the failure signature only after a repeated pattern", () => {
  let state = withGoal("Goal: investigate the build failure");
  state = recordFailure(state, { tool: "bash", error: "compiler exited 1" });
  assert.doesNotMatch(buildGoalAnchor(state), /compiler exited 1/);
  state = recordFailure(state, { tool: "bash", error: "compiler exited 2" });
  state = recordFailure(state, { tool: "bash", error: "compiler exited 3" });
  assert.match(buildGoalAnchor(state), /Repeated failure pattern/);
  assert.match(buildGoalAnchor(state), /compiler exited 3/);
});
