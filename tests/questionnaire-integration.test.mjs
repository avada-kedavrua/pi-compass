import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuestionnaireRecord, questionnaireFailureResultPatch } from "../src/questionnaire-integration.mjs";

test("full questionnaire projection preserves complete answer text and strips preview payloads", () => {
  const source = {
    outcome: "partial",
    answers: [{
      questionIndex: 0,
      question: "Q".repeat(900),
      kind: "custom",
      answer: "A".repeat(1_200),
      selected: ["choice".repeat(40)],
      notes: "N".repeat(800),
      preview: "rich preview payload",
    }],
    unanswered: [3],
    globalNote: "G".repeat(1_000),
  };
  const full = normalizeQuestionnaireRecord(source, { preserveFullText: true });
  assert.equal(full.outcome, "partial");
  assert.equal(full.answers[0].question, source.answers[0].question);
  assert.equal(full.answers[0].answer, source.answers[0].answer);
  assert.deepEqual(full.answers[0].selected, source.answers[0].selected);
  assert.equal(full.answers[0].notes, source.answers[0].notes);
  assert.deepEqual(full.unanswered, [3]);
  assert.equal(full.globalNote, source.globalNote);
  assert.equal(full.answers[0].hasPreview, true);
  assert.equal("preview" in full.answers[0], false);
  const bounded = normalizeQuestionnaireRecord(source);
  assert.ok(bounded.answers[0].question.length <= 400);
  assert.ok(bounded.answers[0].answer.length <= 500);
});

test("questionnaire errors are not decisions and unanswered indexes override an answered outcome", () => {
  assert.equal(normalizeQuestionnaireRecord({ error: "session_load_failed", cancelled: true }), null);
  assert.equal(normalizeQuestionnaireRecord({ isError: true, answers: [{ questionIndex: 0, question: "Q", kind: "custom", answer: "A" }] }), null);
  assert.equal(normalizeQuestionnaireRecord({ outcome: "answered", answers: [{ questionIndex: 0, question: "Q", kind: "option", answer: "A" }], unanswered: [1] }).outcome, "partial");
});

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
