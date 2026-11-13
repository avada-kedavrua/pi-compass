const clip = (value, max = 80) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Normalize the structured Pi ask-user-questions result without retaining preview content.
 * `preserveFullText` is for context-retention snapshots that must not truncate answers.
 */
export function normalizeQuestionnaireRecord(value, { preserveFullText = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answers = Array.isArray(value.answers)
    ? (preserveFullText ? value.answers : value.answers.slice(0, 4)).map((answer) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
      const questionIndex = Number.isInteger(answer.questionIndex) && answer.questionIndex >= 0
        && (preserveFullText || answer.questionIndex < 4) ? answer.questionIndex : null;
      const projectText = (text, max) => preserveFullText
        ? (typeof text === "string" ? text : "")
        : clip(text, max);
      const question = projectText(answer.question, 400);
      const kind = ["option", "custom", "multi"].includes(answer.kind) ? answer.kind : null;
      if (questionIndex === null || !question.trim() || !kind) return null;
      const selectedValues = Array.isArray(answer.selected)
        ? answer.selected.filter((item) => typeof item === "string" && item.trim())
        : [];
      const selected = [...new Set((preserveFullText ? selectedValues : selectedValues.slice(0, 4))
        .map((item) => projectText(item, 60)))];
      const answerText = typeof answer.answer === "string" ? projectText(answer.answer, 500) : null;
      const notes = projectText(answer.notes, 300);
      return {
        questionIndex,
        question,
        kind,
        answer: answerText,
        ...(selected.length ? { selected } : {}),
        ...(notes ? { notes } : {}),
        ...(answer.hasPreview === true || (typeof answer.preview === "string" && answer.preview.length > 0) ? { hasPreview: true } : {}),
      };
    }).filter(Boolean)
    : [];
  const unansweredValues = Array.isArray(value.unanswered)
    ? value.unanswered.filter((item) => Number.isInteger(item) && item >= 0 && (preserveFullText || item < 4))
    : [];
  const unanswered = [...new Set(preserveFullText ? unansweredValues : unansweredValues.slice(0, 4))];
  const globalNote = typeof value.globalNote === "string"
    ? (preserveFullText ? value.globalNote : clip(value.globalNote, 600))
    : "";
  const cancelled = value.outcome === "declined" || value.cancelled === true;
  const suppliedOutcome = ["answered", "partial", "declined"].includes(value.outcome) ? value.outcome : null;
  if (!cancelled && answers.length === 0 && unanswered.length === 0 && !globalNote) return null;
  const outcome = cancelled ? "declined" : suppliedOutcome ?? (unanswered.length ? "partial" : "answered");
  return {
    outcome,
    answers,
    ...(unanswered.length ? { unanswered } : {}),
    ...(globalNote ? { globalNote } : {}),
  };
}

export function questionnaireFailureResultPatch(event) {
  const toolName = String(event?.toolName ?? "");
  const details = event?.details;
  if (!/ask.*user.*question|ask_user_question/i.test(toolName)
    || !details || typeof details !== "object" || Array.isArray(details) || !details.error) return null;
  const code = clip(details.error) || "unknown";
  const originalContent = Array.isArray(event.content) ? event.content : [];
  const patch = {
    content: [{
      type: "text",
      text: `Questionnaire unavailable (${code}). No Human answer was received. This is not a Human decline and must not be treated as a decision. If the missing choice is required, ask the user directly in the conversation.`,
    }, ...originalContent],
    details,
    isError: true,
  };
  if (event.structuredContent !== undefined) patch.structuredContent = event.structuredContent;
  return patch;
}
