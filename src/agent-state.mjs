import { addressedConstraints, buildStateSnapshot, acceptanceStatus, dagApprovalStatus, HUMAN_INPUT_REVIEW } from "./goal-run.mjs";
import { readyTasks, taskAssessmentIsCurrent, taskDependencies, unmetTaskPrerequisites } from "./dag-core.mjs";
import { delegationCandidates } from "./execution-orchestrator.mjs";
import { nodeInputResolver } from "./node-inputs.mjs";
import { approvalPrompt, pendingApprovalRequests } from "./dag-approval.mjs";
import { humanSourceRef } from "./goal-sources.mjs";
import { normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";

export function planApproval(state, branch, transportIssue) {
  const { status, goalStatus, approved, reason } = dagApprovalStatus(state);
  const approval = { goalApproval: goalStatus, approval: status, ...(reason ? { approvalReason: reason } : {}) };
  if (state.plan.stopped) return { ...approval, stopped: state.plan.stopped, next: "Patch the stopped DAG or discard it once all active work is settled." };
  if (approved || (!reason && goalStatus === "approved" && !state.plan.tasks.length)) return approval;
  let next;
  if (reason === "human_input_unreviewed") {
    const ref = branch && state.latestHumanEntryId ? humanSourceRef(branch, state.latestHumanEntryId) : undefined;
    return { ...approval, next: HUMAN_INPUT_REVIEW, ...(ref ? { input: { ref, reviewed: false } } : {}) };
  }
  else if (reason === "goal_criteria_missing") next = "Define final Goal criteria with compass_goal before running the DAG.";
  else if ([status, goalStatus].includes("declined")) next = "Approval was declined. Revise or discard the DAG; do not execute it.";
  else if (goalStatus === "modified") next = "Goal is not approved. Apply requested changes with compass_goal update; if no edit is needed, use compass_plan request_approval. Then present the new prompt.";
  else if (status === "modified") next = "DAG is not approved. Apply requested changes with compass_plan patch; if no edit is needed, use compass_plan request_approval. Then present the new prompt.";
  else if ([status, goalStatus].includes("presented")) next = "If the presented questionnaire ended without a result, use compass_plan request_approval to reissue it.";
  if (next) return { ...approval, next };
  const prompt = approvalPrompt(state);
  if (!prompt) return { ...approval, next: "If approval is still needed, call compass_plan request_approval, then present its prompt." };
  const issue = transportIssue?.();
  if (issue) return { ...approval, next: `${issue} Then read compass_state(view=plan) for the prompt. Chat replies cannot approve.` };
  const present = "Pass prompt unchanged to the native ask_user_question tool directly, outside Code Mode. Chat replies cannot approve.";
  return { ...approval, prompt, next: state.plan.tasks.length ? present : `If using a DAG, define the DAG first to ask once. Otherwise: ${present}` };
}

export function planProgress(state, branch, context, preview, transportIssue) {
  const frame = context.frames.at(-1);
  const approval = planApproval(state, branch, transportIssue);
  if (frame && approval.next) {
    delete approval.prompt;
    approval.next = frame.node
      ? "The current node can report its outcome. Return or throw to main before revising or approving the Goal or DAG."
      : "Return to main before revising or approving the Goal or DAG.";
  }
  if (approval.approval !== "approved" || approval.goalApproval !== "approved" || approval.approvalReason) return approval;
  if (state.plan.stopped) return approval;
  const plan = state.plan;
  const graphReady = readyTasks(plan);
  const resolveInputs = nodeInputResolver(plan, context, branch, preview);
  const ready = {};
  const waiting = [];
  const afterFrame = {};
  const queued = frame ? afterFrame : ready;
  for (const task of graphReady) {
    if (task.executor === "subagent") continue;
    if (!frame && task.executor === "parent") {
      try {
        resolveInputs(task);
      } catch (error) {
        waiting.push({ taskId: task.id, reason: error.message });
        continue;
      }
    }
    queued[task.executor] ??= [];
    queued[task.executor].push(task.id);
  }
  const eligible = delegationCandidates(plan, graphReady).map(({ id }) => id);
  const prerequisites = new Set(plan.tasks.filter((task) => task.status === "pending").flatMap(taskDependencies));
  const assess = plan.tasks.filter((task) => task.status === "done" && prerequisites.has(task.id)
    && (!task.assessment || !taskAssessmentIsCurrent(plan, task)) && !unmetTaskPrerequisites(plan, task).length).map(({ id }) => id);
  const review = plan.tasks.filter((task) => task.status === "done" && task.assessment && task.assessment.status !== "pass"
    && taskAssessmentIsCurrent(plan, task)).map(({ id }) => id);
  const unknown = plan.executions.some((batch) => batch.status === "unknown");
  const dispatchIssue = unknown ? "Resolve unknown native attempts before new child dispatch. See compass_state(view=execution)."
    : plan.executions.findLast((batch) => batch.status === "failed" && batch.taskIds.some((id) => eligible.includes(id)))?.error;
  return { ...approval, ready, ...(Object.keys(afterFrame).length ? { afterFrame } : {}), ...(eligible.length ? { dispatchEligible: eligible } : {}),
    ...(assess.length ? { assess } : {}), ...(review.length ? { review } : {}),
    ...(waiting.length ? { waiting } : {}), ...(dispatchIssue ? { dispatchIssue } : {}) };
}

function taskView(plan, task, detail) {
  const { id, title, status, executor, assessment, evidence, reason } = task;
  const result = { id, title, status, executor, ...(reason ? { reason } : {}) };
  if (assessment) {
    result.assessment = { current: taskAssessmentIsCurrent(plan, task), status: assessment.status };
    if (detail) {
      if (assessment.evidence && assessment.evidence !== evidence) result.assessment.evidence = assessment.evidence;
      for (const field of ["caveats", "unresolvedCaveats"]) if (assessment[field]?.length) result.assessment[field] = assessment[field];
    }
  }
  if (detail) {
    for (const field of ["dependsOn", "acceptance", "writeScope", "output", "frameScope", "fromTasks", "inputRefs", "artifacts", "evidence"]) {
      if (task[field]?.length) result[field] = task[field];
    }
    if (executor === "subagent") Object.assign(result, { agent: task.agent, dispatchReason: task.dispatchReason });
  }
  return result;
}

function planView(state, branch, context, preview, transportIssue, taskId) {
  const plan = state.plan;
  if (taskId !== undefined) {
    const task = plan.tasks.find(({ id }) => id === taskId);
    if (!task) throw new Error(`Unknown or stale task ${taskId} in the current DAG. No state changed.`);
    return { task: taskView(plan, task, true) };
  }
  const progress = state.goal.current ? planProgress(state, branch, context, preview, transportIssue) : {};
  return plan.tasks.length ? { ...progress, tasks: plan.tasks.map((task) => taskView(plan, task, false)) } : { plan: null, ...progress };
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

function visibleHumanInput(state, branch, frame) {
  const id = state.latestHumanEntryId;
  const reviewed = id === state.goal.reviewedInputId;
  if (!id || (frame && reviewed)) return undefined;
  return { ref: humanSourceRef(branch, id), ...(state.goal.current ? { reviewed } : {}) };
}

function summaryView(state, branch, context, cursor) {
  const frame = context.frames.at(-1);
  const result = buildStateSnapshot(state, cursor, { contextRevision: context.revision, contextFrame: frame ? { active: true, id: frame.id } : { active: false } });
  if (result.unchanged) return result;
  if (result.goal) delete result.goal.version;
  if (result.plan) delete result.plan.revision;
  const input = visibleHumanInput(state, branch, frame);
  if (input) result.input = input;
  else delete result.input;
  if (frame) result.returnMode = frame.node ? "node-outcome" : "ordinary";
  else result.frame = "main";
  return result;
}

function goalView(state, branch, frame, transportIssue) {
  const { version, original, current, criteria, constraints } = state.goal;
  const input = visibleHumanInput(state, branch, frame);
  if (!current) return { goal: null, ...(input ? { input } : {}) };
  let sources = branch;
  if (frame) {
    const first = branch.findIndex(({ id }) => id === frame.boundaryId);
    sources = first < 0 ? [] : branch.slice(first + 1);
  }
  const replies = state.humanDecisions.filter((item) => item.goalVersion === version
    && (!frame || sources.some(({ id }) => id === item.sourceEntryId))).map((item) => {
    const raw = sources.findLast((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === item.sourceCallId);
    const questionnaire = raw?.message.details ? normalizeQuestionnaireRecord(raw.message.details, { preserveFullText: true }) : item.questionnaire;
    return { id: item.id, ...(questionnaire ? { questionnaire } : { text: item.text }) };
  });
  const decisions = state.decisions.filter((item) => item.goalVersion === version).map(({ id, summary, rationale, evidence, supersededBy }) => ({ id, summary, ...(rationale ? { rationale } : {}), ...(evidence ? { evidence } : {}), ...(supersededBy ? { supersededBy } : {}) }));
  const checkpoints = state.checkpoints.filter((item) => item.goalVersion === version).map(({ id, summary, ref }) => ({ id, summary, ref }));
  return { goal: { current, ...(current === original ? {} : { original }), constraints: addressedConstraints(constraints) },
    ...(frame ? {} : planApproval(state, undefined, transportIssue)),
    ...(criteria.length ? { criteria: criteria.map(({ id, text }) => ({ id, text })) } : {}), ...(input ? { input } : {}),
    ...(replies.length ? { humanAnswers: replies } : {}), ...(decisions.length ? { decisions } : {}), ...(checkpoints.length ? { checkpoints } : {}),
  };
}

export function agentState(state, branch, context, { view = "summary", cursor, limit = 12, taskId } = {}, preview, transportIssue) {
  if (view !== "summary" && cursor !== undefined) throw new Error("cursor applies only to the summary view. No state changed.");
  if (view !== "plan" && taskId !== undefined) throw new Error("taskId applies only to the plan view. No state changed.");
  if (view === "summary") return summaryView(state, branch, context, cursor);
  if (view === "goal") return goalView(state, branch, context.frames.at(-1), transportIssue);
  if (view === "plan") return planView(state, branch, context, preview, transportIssue, taskId);
  if (view === "proposal") {
    if (context.frames.length) throw new Error("Inspect approval proposals from main. No state changed.");
    return { proposals: pendingApprovalRequests(state).map(({ target, questionnaire }) => ({ target, preview: questionnaire.options[0].preview })) };
  }
  if (view === "acceptance") return acceptanceView(state);
  if (view === "execution") return executionView(state);
  if (view === "history") {
    const events = state.events.slice(-limit);
    return { events: events.map(({ id, kind, summary, text, ref, status }) => ({ id, kind, summary, ...(text ? { text } : {}), ...(ref ? { ref } : {}), ...(status ? { status } : {}) })), ...(events.length < state.events.length || Number(state.events[0]?.id?.slice(1)) > 1 ? { historyGap: true } : {}) };
  }
  throw new Error(`Unknown state view ${view}. No state changed.`);
}
