import assert from "node:assert/strict";
import { bindApprovalQuestionnaire, captureHumanDecision, emptyGoalRunState, observeHumanInput, setGoal } from "../../src/goal-run.mjs";
import { pendingApprovalRequests } from "../../src/dag-approval.mjs";

export function exactAnswers(questions) {
  return questions.map(({ question, options: [option] }, questionIndex) => ({ questionIndex, question, kind: "option", answer: option.label, selected: [option.label], preview: option.preview }));
}

export function approveDefinitions(state) {
  const requests = pendingApprovalRequests(state);
  const questions = requests.map(({ questionnaire }) => questionnaire);
  const sourceEntryId = `entry-${requests[0].id}`;
  const sourceCallId = `approval-${requests[0].id}`;
  const bound = bindApprovalQuestionnaire(state, { questions }, sourceEntryId, sourceCallId);
  assert.equal(bound.bound, true);
  return captureHumanDecision(bound.state, { sourceEntryId, sourceCallId, details: { answers: exactAnswers(questions) } }).state;
}

export function createGoalState(current, { constraints = [], criteria = ["Goal result is supported by evidence"], sourceId = "human-source" } = {}) {
  const observed = observeHumanInput(emptyGoalRunState(), sourceId).state;
  return setGoal(observed, { expectedVersion: 0, current, constraints, criteria }).state;
}
