import { createHash, randomUUID } from "node:crypto";

export const DAG_APPROVAL_QUESTION = "Approve this exact Goal DAG for execution?";
export const DAG_APPROVAL_HEADER = "DAG approval";
export const DAG_APPROVAL_OPTION = "Approve this exact DAG";
export const DAG_REVISION_OPTION = "Revise the DAG";
const DAG_APPROVAL_DESCRIPTION = "Authorize execution exactly as shown in the preview.";
const DAG_REVISION_DESCRIPTION = "Withhold approval and revise the Goal DAG.";

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
        .filter((item) => item.goalVersion === version && item.sourceEntryId !== state?.plan?.approvalRequest?.sourceEntryId)
        .map((item) => ({ id: item.id, sourceEntryId: item.sourceEntryId ?? "", text: item.text, questionnaire: item.questionnaire ?? null })),
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
  const tasks = state.plan.tasks.map((task) => `${task.id}: ${task.title}; depends on ${task.dependsOn.join(", ") || "none"}; executor=${task.executor ?? "parent"}; agent=${task.agent ?? ""}; dispatchReason=${task.dispatchReason ?? ""}; output=${task.output ?? ""}; writeScope=${task.writeScope ?? ""}; acceptance=${task.acceptance}`).join("\n");
  const decisions = [
    ...(state.humanDecisions ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => item.summary || item.text),
    ...(state.decisions ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => `${item.id}: ${item.summary}${item.supersededBy ? ` (superseded by ${item.supersededBy})` : ""}`),
    ...(state.plan.decisions ?? []).map((item) => `${item.id}: ${item.summary}`),
  ].filter(Boolean);
  const question = DAG_APPROVAL_QUESTION;
  const preview = [
    `Approval request ${id}. This authorizes execution only; it does not establish task success or final Goal acceptance.`,
    `Current Goal v${state.goal.version ?? 1}: ${state.goal.current}`,
    `Plan acceptance criteria:\n${(state.plan.acceptanceCriteria ?? []).map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    `Goal acceptance criteria:\n${(state.goal.criteria ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => `- ${item.id}: ${item.text}`).join("\n") || "- none recorded"}`,
    `Tasks (DAG revision ${state.plan.revision}):\n${tasks}`,
    `Human constraints:\n${(state.sessionDirectives ?? []).filter((item) => item.goalVersion === (state.goal.version ?? 1)).map((item) => `- ${item.text}`).join("\n") || "- none recorded"}`,
    `Relevant Human decisions:\n${decisions.map((item) => `- ${item}`).join("\n") || "- none recorded"}`,
  ].join("\n\n");
  const questionnaire = {
    question,
    header: DAG_APPROVAL_HEADER,
    multiSelect: false,
    options: [
      { label: DAG_APPROVAL_OPTION, description: DAG_APPROVAL_DESCRIPTION, preview },
      { label: DAG_REVISION_OPTION, description: DAG_REVISION_DESCRIPTION },
    ],
  };
  return {
    id,
    binding,
    goalVersion: state.goal.version ?? 1,
    planRevision: state.plan.revision,
    question,
    questionnaire,
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
    && request.sourceEntryId
    && request.binding === dagApprovalBinding(state)
    && approval.binding === request.binding
    && approval.sourceEntryId === request.sourceEntryId
    && approval.goalVersion === (state.goal?.version ?? 1));
}

export function matchesDagApprovalQuestion(request, input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length !== 1 || !request?.questionnaire) return false;
  const question = questions[0];
  const expected = request.questionnaire;
  if (!question || typeof question !== "object" || Array.isArray(question)) return false;
  const exactKeys = (value, keys) => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  if (!exactKeys(question, ["question", "header", "multiSelect", "options"])
    || question.question !== expected.question
    || question.header !== expected.header
    || question.multiSelect !== expected.multiSelect
    || !Array.isArray(question.options)
    || question.options.length !== expected.options.length) return false;
  return question.options.every((option, index) => {
    const expectedOption = expected.options[index];
    const expectedKeys = expectedOption.preview === undefined ? ["label", "description"] : ["label", "description", "preview"];
    return option && typeof option === "object" && !Array.isArray(option)
      && exactKeys(option, expectedKeys)
      && option.label === expectedOption.label
      && option.description === expectedOption.description
      && option.preview === expectedOption.preview;
  });
}

export function clearDagApprovalAnswer(request, questionnaire) {
  if (!request?.id || !request.sourceEntryId || !questionnaire || questionnaire.outcome !== "answered") return false;
  if (questionnaire.answers?.length !== 1 || questionnaire.unanswered?.length) return false;
  const answer = questionnaire.answers[0];
  const expectedQuestion = request.question.trim();
  const questionMatches = answer.question === expectedQuestion.slice(0, 400).trimEnd()
    || answer.question === (expectedQuestion.length > 400 ? `${expectedQuestion.slice(0, 399).trimEnd()}…` : expectedQuestion);
  return answer.questionIndex === 0
    && questionMatches
    && answer.kind === "option"
    && answer.answer === DAG_APPROVAL_OPTION
    && !answer.notes?.trim()
    && !questionnaire.globalNote?.trim()
    && (!answer.selected || (answer.selected.length === 1 && answer.selected[0] === DAG_APPROVAL_OPTION));
}
