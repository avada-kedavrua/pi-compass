import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyGoalRunState,
  observeHumanInput,
  setGoal,
  stateCursor,
  normalizeGoalRunState,
  captureHumanDecision,
  recordHumanQuestionnaireFailure,
  recordDecision,
  recordCheckpoint,
  recordFailure,
  mergeTrace,
  recordAcceptanceResult,
  acceptanceStatus,
  goalOutcomeStatus,
  buildRecentEvents,
  buildStateSnapshot,
  buildGoalDetails,
  transitionTasks,
  reconcileUnknownExecutionTasks,
  revisePlanState,
  discardPlan,
  bindDagApprovalQuestionnaire,
  renewDagApprovalRequest,
  dagApprovalStatus,
  recordTaskAssessment,
} from "../src/goal-run.mjs";
import { DAG_APPROVAL_OPTION } from "../src/dag-approval.mjs";
import { emptyDagState, readyTasks, updateTasks, taskAssessmentIsCurrent } from "../src/dag-core.mjs";

const criteria = ["API request returns expected data", "Started processes are cleaned up"];
const tasks = [
  { id: "api", title: "Inspect API", acceptance: "API route and health semantics documented", dependsOn: [], writeScope: "read-only" },
  { id: "ui", title: "Inspect UI", acceptance: "Primary route and request path documented", dependsOn: [], writeScope: "read-only" },
  { id: "smoke", title: "Implement smoke path", acceptance: "Critical UI-to-API path is exercised", dependsOn: ["api", "ui"], writeScope: "src/smoke" },
];

let testHumanSequence = 0;
function withGoal(prompt = "Create a reliable full-stack smoke test", goalCriteria = []) {
  const sourceEntryId = `fixture-goal-${++testHumanSequence}`;
  const state = observeHumanInput(emptyGoalRunState(), sourceEntryId).state;
  return setGoal(state, { expectedVersion: 0, current: prompt, sourceIds: [sourceEntryId], constraints: [], criteria: goalCriteria }).state;
}
function withCriteria(state, criteria) {
  const result = setGoal(state, { expectedVersion: state.goal.version, current: state.goal.current, constraints: state.goal.constraints, sourceIds: state.goal.sourceIds, criteria });
  return { ...result, criteria: result.state.goal.criteria };
}
function approvalInput(request) { return { questions: [structuredClone(request.questionnaire)] }; }
function approvePlan(state) {
  const request = state.plan.approvalRequest;
  const callId = `approval-${request.id}`;
  const sourceEntryId = `entry-${request.id}`;
  const before = structuredClone(state);
  const bound = bindDagApprovalQuestionnaire(state, approvalInput(request), sourceEntryId, callId);
  assert.equal(bound.bound, true);
  assert.deepEqual(state, before, "binding must not mutate prior or native persisted records");
  return captureHumanDecision(bound.state, {
    source: "ask_user_question",
    sourceEntryId,
    sourceCallId: callId,
    details: { answers: [{ questionIndex: 0, question: request.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION], preview: request.questionnaire.options[0].preview }] },
  }).state;
}
function plannedGoal(prompt) { return withGoal(prompt, criteria); }
function withPlan(state) {
  if (!state.goal.criteria.length) state = withCriteria(state, criteria).state;
  return approvePlan(revisePlanState(state, { tasks }).state);
}
function completeAndAssess(state, taskId, evidence) {
  state = transitionTasks(state, "done", [{ id: taskId, evidence }], updateTasks).state;
  return recordTaskAssessment(state, { taskId, status: "pass", evidence: `Assessment against approved criterion: ${evidence}`, caveats: [], unresolvedCaveats: [] }).state;
}
test("approval correlation and questionnaire deduplication use both persisted identities", () => {
  let state = revisePlanState(plannedGoal(), { tasks }).state;
  const request = state.plan.approvalRequest;
  const entryId = "same-assistant-entry";
  const callId = "approval-call";
  state = bindDagApprovalQuestionnaire(state, approvalInput(request), entryId, callId).state;
  const details = { answers: [{ questionIndex: 0, question: request.question, kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION] }] };
  const wrong = captureHumanDecision(state, { source: "ask_user_question", sourceEntryId: entryId, sourceCallId: "other-call", details });
  assert.equal(dagApprovalStatus(wrong.state).approved, false);
  const right = captureHumanDecision(wrong.state, { source: "ask_user_question", sourceEntryId: entryId, sourceCallId: callId, details });
  assert.equal(dagApprovalStatus(right.state).approved, false, "a separate Human decision changes the exact approval binding");
  const renewed = approvePlan(renewDagApprovalRequest(right.state).state);
  assert.equal(dagApprovalStatus(renewed).approved, true);
  assert.equal(captureHumanDecision(renewed, { source: "ask_user_question", sourceEntryId: renewed.plan.approvalRequest.sourceEntryId, sourceCallId: renewed.plan.approvalRequest.toolCallId, details }).captured, false);
  const failed = recordHumanQuestionnaireFailure(right.state, { sourceEntryId: entryId, sourceCallId: "failure-one", errorCode: "no_ui" });
  const anotherFailure = recordHumanQuestionnaireFailure(failed.state, { sourceEntryId: entryId, sourceCallId: "failure-two", errorCode: "no_ui" });
  assert.equal(anotherFailure.captured, true);
});

test("questionnaire failures correlate and deduplicate by persisted entry and call pair", () => {
  const state = revisePlanState(plannedGoal(), { tasks }).state;
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
  state.plan.executions = [{ requestId: "native-batch", status: "unknown", taskIds: ["api"], planRevision: state.plan.revision, results: [{ id: "api", status: "unknown" }] }];
  state = observeHumanInput(state, "followup-human-entry").state;
  assert.equal(dagApprovalStatus(state).approved, false);
  const reconciled = reconcileUnknownExecutionTasks(state, "native-batch", [{ id: "api", status: "done", evidence: "native terminal result" }], updateTasks).state;
  assert.equal(reconciled.plan.tasks.find((task) => task.id === "api").status, "done");
  assert.equal(reconciled.plan.tasks.find((task) => task.id === "ui").status, "pending");
  assert.throws(() => transitionTasks(reconciled, "start", [{ id: "ui" }], updateTasks), /current correlated Human approval/);
});

test("ask-user-question choices are kept as authoritative decisions and retained as authoritative decisions", () => {
  let state = withGoal("Goal: deliver the feature");
  const captured = captureHumanDecision(state, {
    source: "ask_user_question", sourceEntryId: "entry-q1", sourceCallId: "q1",
    text: 'User has answered your questions: "Delivery"="Push origin/main only".',
  });
  assert.equal(captured.captured, true);
  assert.equal(captured.state.humanDecisions[0].goalVersion, 1);
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
  assert.match(JSON.stringify(buildGoalDetails(captured.state).humanAnswers), /Keep HMR enabled/);
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

test("material decisions and checkpoints work without a DAG", () => {
  let state = withGoal();
  state = recordDecision(state, { summary: "Do not reset shared DB", rationale: "No disposable test DB exists", evidence: "No test DB URL in config" }).state;
  state = recordCheckpoint(state, { summary: "Before API integration", ref: "git:abc123", evidence: "Baseline tests pass" }).state;
  assert.equal(state.decisions[0].id, "D1");
  assert.equal(state.checkpoints[0].id, "C1");
});

test("tool failures are on-demand trace, remain on-demand trace data", () => {
  let state = withGoal();
  state = recordFailure(state, { tool: "bash", error: "command exited 1" });
});

test("reopening a prerequisite resets downstream dependents but preserves unrelated work", () => {
  let state = withPlan(withGoal());
  state = completeAndAssess(state, "api", "API inspected");
  state = completeAndAssess(state, "ui", "UI inspected");
  state = transitionTasks(state, "start", [{ id: "smoke" }], updateTasks).state;
  state = transitionTasks(state, "done", [{ id: "smoke", evidence: "Smoke passed" }], updateTasks).state;
  // Add an unrelated completed task to make preservation observable.
  state = revisePlanState(state, { tasks: [...tasks, { id: "docs", title: "Document command", acceptance: "Command is documented", dependsOn: [], writeScope: "docs" }], changeReason: "Documentation is a separate deliverable" }).state;
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

test("a withdrawn upstream pass invalidates transitive assessments, not terminal facts", () => {
  const chain = [tasks[0], { ...tasks[1], dependsOn: ["api"] }, { ...tasks[2], dependsOn: ["ui"] }, { id: "docs", title: "Write docs", acceptance: "Docs exist" }];
  let state = approvePlan(revisePlanState(plannedGoal(), { tasks: chain }).state);
  state = completeAndAssess(state, "api", "API evidence");
  state = completeAndAssess(state, "ui", "UI evidence");
  assert.ok(readyTasks(state.plan).some(({ id }) => id === "smoke"));
  state = recordTaskAssessment(state, { taskId: "api", status: "fail", evidence: "Test refuted the API contract" }).state;
  assert.deepEqual(readyTasks(state.plan).map(({ id }) => id), ["docs"]);
  assert.equal(state.plan.tasks[1].status, "done");
  assert.equal(state.plan.tasks[1].evidence, "UI evidence");
  assert.throws(() => recordTaskAssessment(state, { taskId: "ui", status: "pass", evidence: "UI alone looked good" }), /prerequisite|dependencies/);
  state = completeAndAssess(state, "docs", "README is present");
  state = recordTaskAssessment(state, { taskId: "api", status: "pass", evidence: "New API contract verified" }).state;
  assert.ok(!readyTasks(state.plan).some(({ id }) => id === "smoke"), "B needs a fresh check even after A passes again");
});

test("DAG is optional for Goal continuity", () => {
  const state = withGoal();
  assert.equal(state.plan.tasks.length, 0);
});

test("GoalRun rejects obsolete schema versions instead of migrating or silently reinterpreting them", () => {
  assert.throws(() => normalizeGoalRunState({ schemaVersion: 9, goal: { original: "obsolete" }, plan: emptyDagState() }), /Unsupported.*schema/);
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
  assert.throws(() => recordDecision(result.state, { summary: "Bad stale correction", supersedesDecisionIds: ["D999"] }), /Unknown or stale decision IDs/);
});

test("stale task IDs in decisions return the current valid IDs", () => {
  const state = withPlan(withGoal());
  assert.throws(
    () => recordDecision(state, { summary: "Attach decision to a stale task", affectedTaskIds: ["renderer"] }),
    /Unknown affected task ids: renderer\. Current task IDs: api, ui, smoke\./,
  );
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
  let state = revisePlanState(plannedGoal(), { tasks }).state;
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
  const freshDecision = captureHumanDecision(fresh.state, { sourceEntryId: "entry-fresh", sourceCallId: "reused-provider-id", details: { answers: [{ questionIndex: 0, question: renewedRequest.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION, selected: [DAG_APPROVAL_OPTION], preview: renewedRequest.questionnaire.options[0].preview }] } });
  assert.equal(dagApprovalStatus(freshDecision.state).approved, true, "renewed exact approval remains current despite reused provider call ID");
  assert.equal(freshDecision.state.humanDecisions.length, 2, "distinct persisted exchanges sharing a provider ID are both retained");
  const duplicate = captureHumanDecision(freshDecision.state, { sourceEntryId: "entry-fresh", sourceCallId: "different-provider-id", details: { answers: [{ questionIndex: 0, question: renewedRequest.question.slice(0, 400), kind: "option", answer: DAG_APPROVAL_OPTION }] } });
  assert.notEqual(duplicate.kind, "duplicate", "a second tool call in the same persisted entry remains a separate decision");

  const revised = revisePlanState(state, { tasks: tasks.map((task) => task.id === "api" ? { ...task, acceptance: "API route and health semantics are documented with readiness evidence" } : task) }).state;
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
  let state = revisePlanState(plannedGoal(), { tasks: chain }).state;
  state = approvePlan(state);
  for (const id of ["a", "b", "c"]) state = completeAndAssess(state, id, `Original execution evidence for ${id}.`);
  state = revisePlanState(state, { tasks: chain.map((task) => task.id === "a" ? { ...task, acceptance: "A has new evidence" } : task) }).state;
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
  state = observeHumanInput(state, "read-only-human-entry").state;
  assert.equal(dagApprovalStatus(state).approved, false);
  assert.throws(() => transitionTasks(state, "done", [{ id: "api", evidence: "API reviewed." }], updateTasks), /no current correlated Human approval/);
});

test("acceptance evidence accepts realistic bounded evidence and survives state normalization", () => {
  let state = withCriteria(withGoal(), ["The reproducible acceptance artifact exists."]).state;
  const evidence = `artifact=out/acceptance.json; result=PASS; ${"observed output and command provenance ".repeat(40)}`.slice(0, 1682);
  state = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence }).state;
  const normalized = normalizeGoalRunState(state);
  assert.equal(normalized.goal.criteria[0].evidence.length, evidence.trim().length);
  assert.equal(normalized.goal.criteria[0].evidence, evidence.trim());
});

test("drafts do not gate Goal completion; discarding inactive work preserves Goal evidence and plan identity isolation", () => {
  let state = revisePlanState(plannedGoal(), { tasks }).state;
  const revision = state.plan.revision;
  for (const { id } of state.goal.criteria) {
    state = recordAcceptanceResult(state, { criterionId: id, status: "reported_pass", evidence: "Observed independently of the draft" }).state;
  }
  assert.equal(goalOutcomeStatus(state).status, "agent_reported_satisfied");
  const approved = approvePlan(state);
  assert.equal(goalOutcomeStatus(approved).status, "incomplete");
  const started = transitionTasks(approved, "start", [{ id: "api" }], updateTasks).state;
  assert.throws(() => discardPlan(started), /active or unresolved/);
  const discarded = discardPlan(approved).state;
  assert.deepEqual(discarded.goal, approved.goal);
  assert.equal(dagApprovalStatus(discarded).approved, false);
  assert.equal(goalOutcomeStatus(discarded).status, "agent_reported_satisfied");
  assert.ok(revisePlanState(discarded, { tasks }).state.plan.revision > revision);
});

test("reported acceptance does not hide a blocked Goal task", () => {
  let state = withPlan(withGoal());
  state = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence: "API route and health handler verified." }).state;
  state = recordAcceptanceResult(state, { criterionId: "AC2", status: "reported_pass", evidence: "Started processes are cleaned up in the exercised path." }).state;
  state = transitionTasks(state, "block", [{ id: "smoke", reason: "External service credentials are not available." }], updateTasks).state;
  assert.match(buildStateSnapshot(state).caveat, /smoke/);
});

test("acceptance is explicit, evidence-bearing, and never calls an Agent report independently verified", () => {
  let state = withGoal("Ship a reliable feature");
  const defined = withCriteria(state, ["Unit tests pass", "Smoke test reaches the backend"]);
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
});





test("compact state snapshot returns a cursor and only new current-Goal events", () => {
  let state = withGoal("Goal: implement API smoke test");
  const initial = buildStateSnapshot(state, null, { contextFrame: { active: false, depth: 0, id: null } });
  assert.equal(initial.frame, "root");
  const framed = buildStateSnapshot(state, null, { contextFrame: { active: true, depth: 1, id: "frame-1" } });
  assert.equal(framed.frame, "frame-1");
  assert.equal(initial.goal.version, 1);
  assert.equal(initial.goal.currentTruncated, undefined);
  assert.equal(initial.plan, undefined);
  assert.equal(initial.delta, undefined);
  const cursor = initial.cursor;
  state = recordDecision(state, { summary: "Use existing health endpoint", rationale: "Avoid duplicate route", evidence: "src/api/health.ts" }).state;
  const delta = buildStateSnapshot(state, cursor);
  assert.equal(delta.delta.events.length, 1);
  assert.equal(delta.delta.events[0].kind, "decision_recorded");
  assert.equal(delta.delta.events[0].summary, "Use existing health endpoint");
  const unchanged = buildStateSnapshot(state, delta.cursor);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.delta, undefined);
  assert.deepEqual(unchanged, { unchanged: true, cursor: delta.cursor });
  assert.ok(JSON.stringify(unchanged).length < 220, "unchanged cursor response is only a small revision envelope");
});

test("composite state cursor detects revision changes even when event sequence did not change", () => {
  let state = withGoal("Goal: cursor includes revision and event sequence");
  const first = buildStateSnapshot(state);
  state.stateRevision += 1; // e.g. a persisted state/trace update without a user-facing event
  const changed = buildStateSnapshot(state, first.cursor);
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.delta, undefined);
  assert.notEqual(changed.cursor, first.cursor);
});

test("compact state reports a history gap and recovers with a bounded current snapshot", () => {
  let state = withGoal("Goal: preserve event history bounds");
  const oldCursor = "R0-E0-C0";
  for (let i = 0; i < 100; i++) state = recordDecision(state, { summary: `Decision ${i}`, rationale: "test", evidence: `e${i}` }).state;
  const snapshot = buildStateSnapshot(state, oldCursor);
  assert.equal(snapshot.delta.historyGap, true);
  assert.ok(snapshot.delta.events.length <= 4);
  assert.equal(snapshot.delta.cursorAhead, undefined);
});

test("state snapshot never leaks previous-Goal events into the active delta", () => {
  let state = withGoal("Goal: local parser");
  state = recordDecision(state, { summary: "Use local parser", rationale: "initial scope" }).state;
  const beforeChange = buildStateSnapshot(state).cursor;
  state = observeHumanInput(state, "replacement-human").state;
  state = setGoal(state, { expectedVersion: 1, current: "Goal: online visual editing instead", sourceIds: ["replacement-human"], constraints: [] }).state;
  const afterChange = buildStateSnapshot(state, beforeChange);
  assert.equal(afterChange.goal.version, 2);
  assert.ok(afterChange.delta.events.some((event) => event.kind === "goal_replaced"));
  assert.ok(!afterChange.delta.events.some((event) => event.summary.includes("Use local parser")));
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
  const snapshot = buildStateSnapshot(state, "R999-E999-C999");
  assert.equal(snapshot.delta.cursorAhead, true);
  assert.ok(snapshot.delta.events.some((event) => event.kind === "decision_recorded"));
  assert.ok(snapshot.delta.events.length <= 4);
});




test("Goal outcome projection never upgrades Agent-reported acceptance to independent verification", () => {
  let state = withGoal("Goal: ship a reliable feature");
  assert.equal(goalOutcomeStatus(state).status, "not_assessed");
  state = withCriteria(state, ["Build succeeds", "User-visible flow works"]).state;
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
  let state = withCriteria(withGoal("Goal: ship a feature"), ["Build succeeds", "Runtime behavior is correct"]).state;
  state = recordAcceptanceResult(state, { criterionId: "AC1", status: "reported_pass", evidence: "Build exited 0" }).state;
  assert.equal(goalOutcomeStatus(state).status, "incomplete");
  state = recordAcceptanceResult(state, { criterionId: "AC2", status: "failed", evidence: "Runtime returned the wrong result" }).state;
  assert.equal(goalOutcomeStatus(state).status, "failed");
  assert.deepEqual(goalOutcomeStatus(state).failedCriterionIds, ["AC2"]);
  assert.equal(goalOutcomeStatus(emptyGoalRunState()).status, "no_goal");
});

test("Human answers observed before Goal creation never acquire a fictitious future Goal owner", () => {
  let state = captureHumanDecision(emptyGoalRunState(), { source: "ask_user_question", sourceEntryId: "native-question", sourceCallId: "native-call", text: "Read-only investigation first" }).state;
  state = normalizeGoalRunState(state);
  assert.equal(state.humanDecisions[0].goalVersion, 0);
  state = observeHumanInput(state, "human-goal").state;
  state = setGoal(state, { expectedVersion: 0, current: "Investigate safely", sourceIds: ["human-goal"], constraints: [] }).state;
  assert.equal(normalizeGoalRunState(state).humanDecisions[0].goalVersion, 0);
});

test("acceptance definitions and evidence reject oversized or ambiguous inputs without changing prior reports", () => {
  const state = withCriteria(withGoal("Validate the delivered feature"), ["observable result"]).state;
  const before = structuredClone(state);
  for (const criteria of [["same", "same"], ["x".repeat(301)], Array.from({ length: 13 }, (_, index) => `criterion ${index}`)]) assert.throws(() => withCriteria(state, criteria), /criteria/);
  assert.throws(() => recordAcceptanceResult(state, { criterionId: state.goal.criteria[0].id, status: "reported_pass", evidence: "x".repeat(2001) }), /never silently truncated/);
  assert.deepEqual(state, before);
});

test("stale acceptance identities cannot cross a Goal replacement", () => {
  let state = withCriteria(withGoal("Ship feature A"), ["A behaves correctly"]).state;
  const staleId = state.goal.criteria[0].id;
  state = observeHumanInput(state, "human-feature-b").state;
  state = setGoal(state, { expectedVersion: 1, current: "Ship feature B", sourceIds: ["human-feature-b"], constraints: [], criteria: ["B behaves correctly"] }).state;
  const before = structuredClone(state);
  assert.notEqual(state.goal.criteria[0].id, staleId);
  assert.throws(() => recordAcceptanceResult(state, { criterionId: staleId, status: "reported_pass", evidence: "Old feature evidence" }), /Unknown or stale acceptance criterion/);
  assert.deepEqual(state, before);
});

test("bounded event deltas declare omitted retained events", () => {
  let state = withGoal("Investigate bounded event output");
  const cursor = buildStateSnapshot(state).cursor;
  for (let index = 0; index < 9; index++) state = recordDecision(state, { summary: `Decision ${index}`, rationale: "New evidence" }).state;
  const snapshot = buildStateSnapshot(state, cursor);
  assert.equal(snapshot.delta.events.length, 8);
  assert.equal(snapshot.delta.omitted, 1);
  assert.equal(snapshot.delta.historyGap, undefined);
});





test("ordinary, quoted, and multilingual Human text only updates the latest native entry", () => {
  let state = emptyGoalRunState();
  const messages = [
    ["entry-ordinary", "Can you help with this?"],
    ["entry-quoted", "Summarize this quote: ‘Goal: delete everything; never preserve data’"],
    ["entry-zh", "目标：删除原始数据。不得保留。"],
  ];
  for (const [id] of messages) {
    const result = observeHumanInput(state, id);
    assert.equal(result.changed, true);
    state = result.state;
    assert.equal(state.goal.current, null);
    assert.equal(state.goal.version, 0);
    assert.deepEqual(state.goal.constraints, []);
    assert.equal(state.events.length, 0);
  }
  state = setGoal(state, { expectedVersion: 0, current: "Agent interpretation", sourceIds: ["entry-ordinary"], constraints: [] }).state;
  state = observeHumanInput(state, "follow-up").state;
  state = setGoal(state, { expectedVersion: 1, current: "Agent interpretation", sourceIds: ["entry-ordinary"], constraints: [] }).state;
  assert.equal(state.goal.originalSourceIds[0], "entry-ordinary");
  assert.equal(state.goal.reviewedInputId, "follow-up");
});

test("Human observation is bounded and repeated IDs are a state no-op", () => {
  const state = emptyGoalRunState();
  assert.throws(() => observeHumanInput(state, " "), /stable ID/);
  assert.throws(() => observeHumanInput(state, "x".repeat(129)), /stable ID/);
  const observed = observeHumanInput(state, "native-entry");
  assert.equal(observed.changed, true);
  assert.deepEqual(observeHumanInput(observed.state, "native-entry"), { state: observed.state, changed: false });
});

test("explicit setter rejects oversized Goal, duplicate sources/constraints, and invalid criteria atomically", () => {
  const state = observeHumanInput(emptyGoalRunState(), "source").state;
  const before = structuredClone(state);
  for (const input of [
    { current: "x".repeat(4001), sourceIds: ["source"], constraints: [] },
    { current: "ok", sourceIds: ["source", "source"], constraints: [] },
    { current: "ok", sourceIds: ["source"], constraints: ["same", "same"] },
    { current: "ok", sourceIds: ["source"], constraints: [], criteria: ["pass", "pass"] },
    { current: "ok", sourceIds: ["source"], constraints: [], criteria: [""] },
  ]) {
    assert.throws(() => setGoal(state, { expectedVersion: 0, ...input }));
    assert.deepEqual(state, before);
  }
  assert.throws(() => setGoal(state, { expectedVersion: 1, current: "ok", sourceIds: ["source"], constraints: [] }), /Stale Goal version/);
});

test("Goal alone changes criteria and invalidates plan approval and semantic assessments", () => {
  let state = withPlan(withGoal());
  state = completeAndAssess(state, "api", "observed evidence");
  const priorKey = state.plan.definitionKey;
  const changed = withCriteria(state, ["Different criterion"]).state;
  assert.equal(changed.goal.criteria[0].text, "Different criterion");
  assert.notEqual(changed.plan.definitionKey, priorKey);
  assert.equal(changed.plan.tasks[0].evidence, "observed evidence");
  assert.equal(dagApprovalStatus(changed).approved, false);
  assert.equal(taskAssessmentIsCurrent(changed.plan, changed.plan.tasks[0]), false);
  assert.equal(Object.hasOwn(changed.plan, "criteria"), false);
});

test("new Human input locks approval until explicitly acknowledged without rebinding semantic approval", () => {
  let state = withPlan(withGoal());
  const requestId = state.plan.approvalRequest.id;
  assert.equal(dagApprovalStatus(state).approved, true);
  state = observeHumanInput(state, "newest-entry").state;
  assert.equal(dagApprovalStatus(state).approved, false);
  assert.deepEqual(buildGoalDetails(state).input, { id: "newest-entry", reviewed: false });
  state = setGoal(state, { expectedVersion: 1, current: state.goal.current,
    sourceIds: [...state.goal.sourceIds, "newest-entry"], constraints: [] }).state;
  assert.equal(dagApprovalStatus(state).approved, true);
  assert.equal(state.plan.approvalRequest.id, requestId);
  assert.deepEqual(buildGoalDetails(state).input, { id: "newest-entry", reviewed: true });
});

test("same-text constraint changes preserve evidence but invalidate approval; replacement guards unknown identity", () => {
  let state = withPlan(withGoal());
  state.goal.criteria[0].status = "reported_pass";
  state.goal.criteria[0].evidence = "verified";
  const changed = setGoal(state, { expectedVersion: 1, current: state.goal.current,
    sourceIds: state.goal.sourceIds, constraints: ["Preserve data"] }).state;
  assert.equal(changed.goal.criteria[0].status, "reported_pass");
  assert.equal(changed.goal.criteria[0].evidence, "verified");
  assert.equal(dagApprovalStatus(changed).approved, false);
  changed.plan.executions = [{ requestId: "native-unknown", status: "unknown", taskIds: ["api"] }];
  const before = structuredClone(changed);
  assert.throws(() => setGoal(changed, { expectedVersion: 1, current: "Replacement",
    sourceIds: changed.goal.sourceIds, constraints: [] }), /work is active or unresolved/);
  assert.deepEqual(changed, before);
});

test("context-aware cursor and default snapshot stay compact", () => {
  const state = withGoal("An explicitly selected semantic Goal");
  const cursor = stateCursor(state, 7);
  assert.match(cursor, /^R\d+-E\d+-C7$/);
  const frame = { active: true, depth: 2, id: "frame-x", secretContents: "must not leak" };
  const snapshot = buildStateSnapshot(state, null, { contextRevision: 7, contextFrame: frame });
  assert.equal(snapshot.frame, "frame-x");
  assert.equal("runtime" in snapshot, false);
  assert.equal("sourceIds" in snapshot.goal, false);
  assert.equal("acceptance" in snapshot, false);
  const unchanged = buildStateSnapshot(state, cursor, { contextRevision: 7, contextFrame: frame });
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.contextFrame, snapshot.contextFrame);
});
