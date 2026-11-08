# ask-user-question 2.15.0 — contract notes used by Compass v0.9.0

Source: `rpiv-ask-user-question-2.15.0.tar.gz` in this directory. The archive is the user-supplied source, not a vendored runtime dependency.

## Tool result envelope

`buildToolResult(text, details)` returns:

- `content: [{ type: "text", text }]`
- `details: QuestionnaireResult`

`QuestionnaireResult` contains `answers`, `cancelled`, optional `globalNote`, and on partial submission an `unanswered` index list. An answer contains `questionIndex`, `question`, `kind` (`option`, `custom`, `multi`), `answer`, optional `selected`, optional `preview`, and optional `notes`.

The model-facing envelope can include the full selected preview body. GoalRun therefore stores only `hasPreview`, not the preview string, and uses a compact summary as `humanDecisions[].text` when structured details are available. The raw full envelope remains in Pi session history.

## Decline versus failure

The canonical decline text is `User declined to answer questions`. The source deliberately uses it for both cancellation and a no-segments result. A genuine cancellation returns `details.cancelled: true` and may retain `globalNote`.

Failures return `details.error` with one of:

- `no_ui`
- `no_custom_ui`
- `no_questions`
- `empty_options`
- `too_many_questions`
- `duplicate_question`
- `duplicate_option_label`
- `reserved_label`
- `session_load_failed`
- `stale_module_cache`

The source's `no_custom_ui`, `session_load_failed`, and `stale_module_cache` messages explicitly state that the user never saw the questions and this must not be treated as a decline. Compass uses the structured error code, rewrites the misleading model-facing envelope at Pi's `tool_result` boundary, and records `human_questionnaire_error` rather than a Human decision.

## Partial answers

A partial submit is not a decline. The source returns `cancelled: false`, `answers` for completed questions, `unanswered` indexes for blank questions, and an envelope that names unanswered questions. Compass preserves answer records, unanswered indexes, and notes. Question text for unanswered questions remains in the raw tool result envelope.

## Bounds in GoalRun

- Maximum four answer records (matching the tool's four-question limit).
- Question text 400 chars; answer text 500; selected labels 4 x 60; per-question notes 300; global note 600.
- Preview body omitted; `hasPreview` boolean retained.
- Decision summary 420 chars; raw text summary is not duplicated when structured details exist.
