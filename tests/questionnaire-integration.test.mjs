import test from "node:test";
import assert from "node:assert/strict";
import { questionnaireFailureResultPatch } from "../src/questionnaire-integration.mjs";

test("questionnaire failure rewrites the misleading decline envelope into a tool error", () => {
  const details = { answers: [], cancelled: true, error: "session_load_failed" };
  const event = {
    toolName: "ask_user_question",
    content: [{ type: "text", text: "User declined to answer questions" }],
    details,
    isError: false,
  };
  const patch = questionnaireFailureResultPatch(event);
  assert.equal(patch.isError, true);
  assert.match(patch.content[0].text, /No Human answer was received/);
  assert.match(patch.content[0].text, /not a Human decline/);
  assert.equal(patch.content[1].text, "User declined to answer questions", "the original diagnostic/output is preserved after the explicit error classification");
  assert.equal(patch.details, details);
  assert.equal(event.isError, false, "middleware must not mutate the upstream event");
});

test("questionnaire failure preserves structured content when the host supplied it", () => {
  const structuredContent = { status: "declined", source: "extension" };
  const patch = questionnaireFailureResultPatch({
    toolName: "rpiv_ask_user_question",
    details: { error: "no_ui" },
    structuredContent,
  });
  assert.equal(patch.structuredContent, structuredContent);
  assert.equal(patch.details.error, "no_ui");
});

test("unrelated tools and successful questionnaires are untouched", () => {
  assert.equal(questionnaireFailureResultPatch({ toolName: "compass_state", details: { error: "x" } }), null);
  assert.equal(questionnaireFailureResultPatch({ toolName: "ask_user_question", details: { cancelled: false, answers: [] } }), null);
  assert.equal(questionnaireFailureResultPatch({ toolName: "ask_user_question", details: { error: "" } }), null);
});
