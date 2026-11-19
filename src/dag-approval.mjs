import { createHash, randomUUID } from "node:crypto";

export const DAG_APPROVAL_QUESTION = "Approve this exact DAG for execution?";
export const DAG_APPROVAL_OPTION = "Approve this exact DAG";
export const APPROVAL_TARGETS = ["goal", "plan"];

function taskDefinition({ id, title, dependsOn, fromTasks, inputRefs, acceptance, output, executor, writeScope, agent, dispatchReason, frameScope }) {
  return { id, title, dependsOn: [...dependsOn].sort(), fromTasks, inputRefs, acceptance, output, executor, writeScope, agent: executor === "subagent" ? agent : undefined, dispatchReason, frameScope };
}

function definition(state, target) {
  const { version, current, constraints, criteria } = state.goal;
  if (target === "goal") return { version, current, constraints, criteria: criteria.map(({ id, text }) => ({ id, text })) };
  return { version, current, revision: state.plan.revision, tasks: state.plan.tasks.map(taskDefinition) };
}

export function approvalBinding(state, target) {
  return createHash("sha256").update(JSON.stringify(definition(state, target))).digest("hex");
}

export function createApprovalRequest(state, target) {
  const id = randomUUID();
  const data = definition(state, target);
  const isGoal = target === "goal";
  const question = isGoal ? "Approve this exact Goal?" : DAG_APPROVAL_QUESTION;
  const preview = (isGoal ? [
    `Goal proposal ${id}`,
    data.current,
    `Constraints:\n${data.constraints.map((text) => `- ${text}`).join("\n") || "- none"}`,
    `Final criteria:\n${data.criteria.map(({ id: criterion, text }) => `- ${criterion}: ${text}`).join("\n") || "- none"}`,
  ] : [
    `DAG proposal ${id} for Goal v${data.version}: ${data.current}`,
    `Revision ${data.revision}. Ready parent nodes run serially in the listed order. This authorizes work, not its results.`,
    ...data.tasks.map((task) => `${task.id}: ${Object.entries(task).filter(([key, value]) => key !== "id" && value != null && value !== "" && (!Array.isArray(value) || value.length)).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(", ") : value}`).join("; ")}`),
  ]).join("\n\n").replace(/\r\n/g, "\n").replace(/\r/g, "");
  const questionnaire = { question, header: isGoal ? "Goal" : "DAG", multiSelect: false, options: [
    { label: isGoal ? "Approve this exact Goal" : DAG_APPROVAL_OPTION, description: "Approve exactly what is shown in the preview.", preview },
    { label: isGoal ? "Revise the Goal" : "Revise the DAG", description: "Withhold approval and request changes." },
  ] };
  return { id, target, binding: approvalBinding(state, target), question, questionnaire, status: "awaiting_questionnaire" };
}

export function definitionApproved(state, target) {
  const { approvalRequest: request, approval } = state[target];
  return Boolean(request && approval && request.status === "answered" && request.id === approval.requestId
    && request.sourceEntryId && request.toolCallId && approval.sourceEntryId === request.sourceEntryId && approval.sourceCallId === request.toolCallId
    && approval.binding === request.binding && request.binding === approvalBinding(state, target));
}

export function approvalIsCurrent(state) {
  return state.goal.criteria.length > 0 && state.goal.reviewedInputId === state.latestHumanEntryId && definitionApproved(state, "goal") && definitionApproved(state, "plan");
}

export function pendingApprovalRequests(state) {
  if (state.goal.reviewedInputId !== state.latestHumanEntryId) return [];
  return APPROVAL_TARGETS.map((target) => state[target].approvalRequest).filter((request) => request?.status === "awaiting_questionnaire"
    && request.binding === approvalBinding(state, request.target));
}

export function approvalPrompt(state) {
  const requests = pendingApprovalRequests(state);
  if (!requests.length) return null;
  return { questions: requests.map((request) => ({ question: `Review the ${request.questionnaire.header} proposal?`, header: request.questionnaire.header, multiSelect: false, options: [
    { label: "Review proposal", description: "Open the exact proposal for your decision.", preview: `P.${request.id}` },
    { label: "Request changes", description: "Do not approve this proposal." },
  ] })) };
}

export function matchesApprovalQuestion(request, question) {
  const expected = request.questionnaire;
  const exactKeys = (value, keys) => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  if (!question || typeof question !== "object" || Array.isArray(question) || !exactKeys(question, ["question", "header", "multiSelect", "options"])
    || question.question !== expected.question || question.header !== expected.header || question.multiSelect !== expected.multiSelect
    || !Array.isArray(question.options) || question.options.length !== expected.options.length) return false;
  return question.options.every((option, index) => {
    const canonical = expected.options[index];
    return option && typeof option === "object" && !Array.isArray(option) && exactKeys(option, Object.keys(canonical))
      && option.label === canonical.label && option.description === canonical.description && option.preview === canonical.preview;
  });
}

export function clearApprovalAnswer(request, questionnaire, details) {
  if (!request.sourceEntryId || !questionnaire || !["answered", "partial"].includes(questionnaire.outcome) || questionnaire.globalNote?.trim()) return false;
  const index = request.questionIndex;
  if (questionnaire.unanswered?.includes(index)) return false;
  const answers = questionnaire.answers.filter((answer) => answer.questionIndex === index);
  const raw = Array.isArray(details?.answers) ? details.answers.filter((answer) => answer.questionIndex === index) : [];
  const option = request.questionnaire.options[0];
  return answers.length === 1 && raw.length === 1 && raw[0].preview === option.preview && answers[0].question === request.question
    && answers[0].kind === "option" && answers[0].answer === option.label && !answers[0].notes?.trim()
    && (!answers[0].selected || (answers[0].selected.length === 1 && answers[0].selected[0] === option.label));
}
