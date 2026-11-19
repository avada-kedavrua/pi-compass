import { addressedConstraints, buildStateSnapshot, buildGoalDetails, acceptanceStatus, dagApprovalStatus } from "./goal-run.mjs";
import { readyTasks, taskAssessmentIsCurrent } from "./dag-core.mjs";
import { approvalPrompt } from "./dag-approval.mjs";
import { agentGoalDetails, humanSourceRef, latestHumanSource } from "./goal-sources.mjs";
import { normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";

export function planView(state) {
  if (!state.plan.tasks.length) return { plan: null };
  const approval = dagApprovalStatus(state);
  const prompt = !approval.approved ? approvalPrompt(state.plan.approvalRequest) : null;
  return {
    approval: approval.approved ? "approved" : approval.status,
    ...(state.plan.stopped ? { stopped: state.plan.stopped } : {}),
    ...(prompt ? { prompt } : {}),
    ...(approval.approved ? { ready: readyTasks(state.plan).map((task) => task.id) } : {}),
    tasks: state.plan.tasks.map((task) => {
      const { id, title, dependsOn, acceptance, status, executor, agent, writeScope, output, dispatchReason, frameScope, reason, evidence, assessment } = task;
      return {
      id, title, dependsOn, acceptance, status, executor,
      ...(executor === "subagent" ? { agent, dispatchReason } : {}), ...(frameScope ? { frameScope } : {}), ...(writeScope ? { writeScope } : {}), ...(output ? { output } : {}),
      ...(reason ? { reason } : {}), ...(evidence ? { evidence } : {}),
      ...(task.fromTasks?.length ? { fromTasks: task.fromTasks } : {}), ...(task.inputRefs?.length ? { inputRefs: task.inputRefs } : {}), ...(task.artifacts?.length ? { artifacts: task.artifacts } : {}),
      ...(assessment ? { assessment: { current: taskAssessmentIsCurrent(state.plan, task), status: assessment.status, evidence: assessment.evidence, ...(assessment.caveats?.length ? { caveats: assessment.caveats } : {}), ...(assessment.unresolvedCaveats?.length ? { unresolvedCaveats: assessment.unresolvedCaveats } : {}) } } : {}),
      };
    }),
  };
}

export function acceptanceView(state) {
  return {
    ...acceptanceStatus(state), independentlyVerified: false,
    criteria: state.goal.criteria.filter((item) => item.goalVersion === state.goal.version).map(({ id, text, status, evidence }) => ({ id, text, status, ...(evidence ? { evidence } : {}) })),
  };
}

export function executionView(state) {
  return { executions: state.plan.executions.map((execution) => ({
    requestId: execution.requestId, status: execution.status, taskIds: execution.taskIds,
    ...(execution.error ? { error: execution.error } : {}),
    results: execution.results.map(({ id, status, runId, requestId, ownerRunId, error, summary, model, fallbackAttempted, cancelRequested }) => ({
      id, status, ...(runId ? { runId } : {}), requestId, ownerRunId,
      ...(error ? { error } : {}), ...(summary ? { summary } : {}), ...(model ? { model } : {}), ...(fallbackAttempted ? { fallbackAttempted: true } : {}), ...(cancelRequested ? { cancelRequested: true } : {}),
    })),
  })) };
}

export function agentState(state, branch, context, { view = "summary", cursor, limit = 12 } = {}) {
  if (view !== "summary" && cursor !== undefined) throw new Error("cursor applies only to the summary view. No state changed.");
  const latest = latestHumanSource(branch);
  const input = latest ? { ref: humanSourceRef(branch, latest), ...(state.goal.current ? { reviewed: state.goal.reviewedInputId === latest } : {}) } : undefined;
  if (view === "summary") {
    const result = buildStateSnapshot(state, cursor, { contextRevision: context.revision, contextFrame: context.frames.at(-1) ? { active: true, id: context.frames.at(-1).id } : { active: false } });
    if (result.goal) { const { version: _version, ...goal } = result.goal; result.goal = goal; }
    if (result.plan) { const { revision: _revision, ...plan } = result.plan; result.plan = plan; }
    if (result.input) result.input = input;
    const frame = context.frames.at(-1);
    if (frame && !result.unchanged) result.returnMode = frame.node ? "node-outcome" : "ordinary";
    return result;
  }
  if (view === "goal") {
    const details = agentGoalDetails(branch, buildGoalDetails(state));
    const replies = state.humanDecisions.filter((item) => item.goalVersion === state.goal.version).map((item) => {
      const raw = branch.findLast((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === item.sourceCallId);
      return { id: item.id, ...(raw?.message.details ? { questionnaire: normalizeQuestionnaireRecord(raw.message.details, { preserveFullText: true }) } : item.questionnaire ? { questionnaire: item.questionnaire } : { text: item.text }) };
    });
    if (details.goal) {
      delete details.goal.version;
      details.goal.constraints = addressedConstraints(details.goal.constraints);
    }
    return { goal: details.goal, ...(details.criteria?.length ? { criteria: details.criteria.map(({ id, text }) => ({ id, text })) } : {}), ...(input ? { input } : {}),
      ...(replies.length ? { humanAnswers: replies } : {}),
      ...(state.decisions.length ? { decisions: state.decisions.filter((item) => item.goalVersion === state.goal.version).map(({ id, summary, rationale, evidence, supersededBy }) => ({ id, summary, ...(rationale ? { rationale } : {}), ...(evidence ? { evidence } : {}), ...(supersededBy ? { supersededBy } : {}) })) } : {}),
      ...(state.checkpoints.length ? { checkpoints: state.checkpoints.filter((item) => item.goalVersion === state.goal.version).map(({ id, summary, ref }) => ({ id, summary, ref })) } : {}),
    };
  }
  if (view === "plan") return planView(state);
  if (view === "acceptance") return acceptanceView(state);
  if (view === "execution") return executionView(state);
  if (view === "history") {
    const events = state.events.slice(-limit);
    return { events: events.map(({ id, kind, summary, text, ref, status }) => ({ id, kind, summary, ...(text ? { text } : {}), ...(ref ? { ref } : {}), ...(status ? { status } : {}) })), ...(events.length < state.events.length || Number(state.events[0]?.id?.slice(1)) > 1 ? { historyGap: true } : {}) };
  }
  throw new Error(`Unknown state view ${view}. No state changed.`);
}
