import { addressedConstraints, buildStateSnapshot, buildGoalDetails, acceptanceStatus, dagApprovalStatus } from "./goal-run.mjs";
import { readyTasks, taskAssessmentIsCurrent, taskDependencies, unmetTaskPrerequisites } from "./dag-core.mjs";
import { delegationCandidates } from "./execution-orchestrator.mjs";
import { nodeInputResolver } from "./node-inputs.mjs";
import { approvalPrompt } from "./dag-approval.mjs";
import { agentGoalDetails, humanSourceRef, latestHumanSource } from "./goal-sources.mjs";
import { normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";

export function planApproval(state) {
  const { status, approved } = dagApprovalStatus(state);
  if (state.plan.stopped) return { approval: status, stopped: state.plan.stopped, next: "Patch the stopped DAG or discard it once all active work is settled." };
  if (approved) return { approval: status };
  let next;
  if (state.goal.reviewedInputId !== state.latestHumanEntryId) next = "Review the latest Human input with compass_goal before continuing.";
  else if (!state.goal.criteria.length) next = "Define Goal acceptance criteria with compass_goal before asking for approval.";
  else if (status === "awaiting_questionnaire") return { approval: status, prompt: approvalPrompt(state.plan.approvalRequest), next: "No questionnaire has been sent. Call ask_user_question with this prompt unchanged." };
  else if (status === "modified") next = "Review the Human's answer. Make any requested edits before asking for approval again.";
  else if (status === "declined") next = "Do not execute the DAG. Review whether to revise it or discard it.";
  else if (status === "presented") next = "The questionnaire was presented. If it ended without a result, use compass_plan request_approval to reissue it.";
  else next = "If approval is still needed, call compass_plan request_approval, then present its prompt.";
  return { approval: status, next };
}

export function planProgress(state, branch, context, preview) {
  const approval = planApproval(state);
  if (approval.approval !== "approved") return approval;
  if (state.plan.stopped) return approval;
  const plan = state.plan;
  const graphReady = readyTasks(plan);
  const resolveInputs = nodeInputResolver(plan, context, branch, preview);
  const ready = {};
  const waiting = [];
  for (const task of graphReady) {
    if (task.executor === "subagent") continue;
    if (task.executor === "parent") {
      try {
        resolveInputs(task);
      } catch (error) {
        waiting.push({ taskId: task.id, reason: error.message });
        continue;
      }
    }
    ready[task.executor] ??= [];
    ready[task.executor].push(task.id);
  }
  const eligible = delegationCandidates(plan, graphReady).map(({ id }) => id);
  const prerequisites = new Set(plan.tasks.filter((task) => task.status === "pending").flatMap(taskDependencies));
  const assess = plan.tasks.filter((task) => task.status === "done" && prerequisites.has(task.id)
    && (!task.assessment || !taskAssessmentIsCurrent(plan, task)) && !unmetTaskPrerequisites(plan, task).length).map(({ id }) => id);
  const unknown = plan.executions.some((batch) => batch.status === "unknown");
  const dispatchIssue = unknown ? "Resolve unknown native attempts before new child dispatch. See compass_state(view=execution)."
    : plan.executions.findLast((batch) => batch.status === "failed" && batch.taskIds.some((id) => eligible.includes(id)))?.error;
  return { ...approval, ready, ...(eligible.length ? { dispatchEligible: eligible } : {}), ...(assess.length ? { assess } : {}),
    ...(waiting.length ? { waiting } : {}), ...(dispatchIssue ? { dispatchIssue } : {}) };
}

function planView(state, branch, context, preview) {
  if (!state.plan.tasks.length) return { plan: null };
  return {
    ...planProgress(state, branch, context, preview),
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

export function agentState(state, branch, context, { view = "summary", cursor, limit = 12 } = {}, preview) {
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
  if (view === "plan") return planView(state, branch, context, preview);
  if (view === "acceptance") return acceptanceView(state);
  if (view === "execution") return executionView(state);
  if (view === "history") {
    const events = state.events.slice(-limit);
    return { events: events.map(({ id, kind, summary, text, ref, status }) => ({ id, kind, summary, ...(text ? { text } : {}), ...(ref ? { ref } : {}), ...(status ? { status } : {}) })), ...(events.length < state.events.length || Number(state.events[0]?.id?.slice(1)) > 1 ? { historyGap: true } : {}) };
  }
  throw new Error(`Unknown state view ${view}. No state changed.`);
}
