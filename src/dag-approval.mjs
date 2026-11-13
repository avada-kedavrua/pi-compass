import { createHash, randomUUID } from "node:crypto";

export const DAG_APPROVAL_QUESTION = "Approve this exact Goal DAG for execution?";
export const DAG_APPROVAL_OPTION = "Approve this exact DAG";
export const DAG_REVISION_OPTION = "Revise the DAG";

function taskDefinition(task) {
  return {
    id: task.id,
    title: task.title,
    dependsOn: [...(task.dependsOn ?? [])].sort(),
    acceptance: task.acceptance,
    output: task.output ?? "",
    writeScope: task.writeScope ?? "",
    executor: task.executor ?? "parent",
    agent: task.agent ?? "",
    dispatchReason: task.dispatchReason ?? "",
  };
}

export function dagApprovalBinding(state) {
  const version = state?.goal?.version ?? 1;
  const definition = {
    goalVersion: version,
    goal: state?.goal?.current ?? null,
    planGoal: state?.plan?.goal ?? null,
    acceptanceCriteria: [...(state?.plan?.acceptanceCriteria ?? [])],
    goalAcceptanceCriteria: (state?.goal?.criteria ?? [])
      .filter((item) => item.goalVersion === version)
      .map((item) => ({ id: item.id, text: item.text })),
    tasks: (state?.plan?.tasks ?? []).map(taskDefinition),
    constraints: (state?.sessionDirectives ?? [])
      .filter((item) => item.goalVersion === version)
      .map((item) => ({ id: item.id, text: item.text, hard: item.hard === true, pinned: item.pinned === true })),
    decisions: {
      human: (state?.humanDecisions ?? [])
        .filter((item) => item.goalVersion === version && item.sourceCallId !== state?.plan?.approvalRequest?.toolCallId)
        .map((item) => ({ id: item.id, sourceCallId: item.sourceCallId, text: item.text, questionnaire: item.questionnaire ?? null })),
      goal: (state?.decisions ?? [])
        .filter((item) => item.goalVersion === version)
        .map((item) => ({ id: item.id, summary: item.summary, rationale: item.rationale, evidence: item.evidence, affectedTaskIds: item.affectedTaskIds ?? [], supersededBy: item.supersededBy ?? null })),
      plan: (state?.plan?.decisions ?? []).map((item) => ({ id: item.id, summary: item.summary, rationale: item.rationale, evidence: item.evidence, affectedTasks: item.affectedTasks ?? [] })),
    },
  };
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

export function createDagApprovalRequest(state) {
  if (!state?.goal?.current || !state?.plan?.tasks?.length) throw new Error("A current Goal DAG is required before requesting approval.");
  const id = randomUUID();
  const binding = dagApprovalBinding(state);
  const tasks = state.plan.tasks.map((task) => `${task.id}: ${task.title}; depends on ${task.dependsOn.join(", ") || "none"}; executor=${task.executor}${task.executor === "subagent" ? `/${task.agent}` : ""}; acceptance=${task.acceptance}`).join("\n");
  const decisions = [
    ...(state.humanDecisions ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => item.summary || item.text),
    ...(state.decisions ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => `${item.id}: ${item.summary}${item.supersededBy ? ` (superseded by ${item.supersededBy})` : ""}`),
    ...(state.plan.decisions ?? []).map((item) => `${item.id}: ${item.summary}`),
  ].filter(Boolean);
  const question = [
    `Approval request ${id}. This question authorizes this plan only; it does not establish task success or final Goal acceptance.`,
    `Current Goal v${state.goal.version ?? 1}: ${state.goal.current}`,
    `Plan acceptance criteria: ${(state.plan.acceptanceCriteria ?? []).map((item, index) => `${index + 1}. ${item}`).join(" ")}`,
    `Tasks (DAG revision ${state.plan.revision}):\n${tasks}`,
    `Human constraints: ${(state.sessionDirectives ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => item.text).join("; ") || "none recorded"}`,
    `Relevant Human decisions: ${decisions.join("; ") || "none recorded"}`,
    "Choose the exact approval option only if this Goal, plan, criteria, dependencies and executors are acceptable. Choose revision or provide custom feedback to withhold approval.",
  ].join("\n\n");
  return {
    id,
    binding,
    goalVersion: state.goal.version ?? 1,
    planRevision: state.plan.revision,
    question,
    createdAt: new Date().toISOString(),
    toolCallId: "",
    status: "awaiting_questionnaire",
  };
}

export function approvalIsCurrent(state) {
  const request = state?.plan?.approvalRequest;
  const approval = state?.plan?.approval;
  return Boolean(request && approval
    && request.status === "answered"
    && request.id === approval.requestId
    && request.toolCallId
    && request.binding === dagApprovalBinding(state)
    && approval.binding === request.binding
    && approval.sourceCallId === request.toolCallId
    && approval.goalVersion === (state.goal?.version ?? 1));
}

export function matchesDagApprovalQuestion(request, input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length !== 1) return false;
  const question = questions[0];
  const options = Array.isArray(question?.options) ? question.options : [];
  const labels = options.map((option) => typeof option === "string" ? option : option?.label);
  return question?.question === request.question
    && labels.length === 2
    && labels[0] === DAG_APPROVAL_OPTION
    && labels[1] === DAG_REVISION_OPTION;
}

export function clearDagApprovalAnswer(request, questionnaire) {
  if (!request?.id || !request.toolCallId || !questionnaire || questionnaire.outcome !== "answered") return false;
  if (questionnaire.answers?.length !== 1 || questionnaire.unanswered?.length) return false;
  const answer = questionnaire.answers[0];
  const expectedQuestion = request.question.trim();
  const questionMatches = answer.question === expectedQuestion.slice(0, 400).trimEnd()
    || answer.question === (expectedQuestion.length > 400 ? `${expectedQuestion.slice(0, 399).trimEnd()}…` : expectedQuestion);
  return answer.questionIndex === 0
    && questionMatches
    && answer.kind === "option"
    && answer.answer === DAG_APPROVAL_OPTION
    && (!answer.selected || (answer.selected.length === 1 && answer.selected[0] === DAG_APPROVAL_OPTION));
}
