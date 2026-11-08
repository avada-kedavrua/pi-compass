const clip = (value, max = 80) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

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
