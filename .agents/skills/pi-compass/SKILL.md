---
name: pi-compass
description: Use Compass for retained Goal/evidence state, same-session attention frames, source recovery, and optional Human-approved DAGs. Load when these reduce the work needed for a real task, not to exercise every capability.
---

# Compass: Agent operating guide

Work normally. Compass changes retained state and future context, not Pi's raw history or the filesystem. Use the smallest useful call; no obligatory Goal, frame, DAG, review or ceremony.

Compass registers seven fixed tools: `compass_goal`, `compass_state`, `compass_context_search`, `compass_context`, `compass_plan`, `compass_acceptance`, `runtime_guard`. Nothing is loaded or opened. If they are absent, the extension is not active: the Human can start Pi with the local package (`pi -e /absolute/path/to/pi-compass`) or enable the project package and `/reload`; `/compass-preflight` reports the registry. Do not edit global settings or assume children inherit Compass.

## Goal and evidence

- `compass_goal({action:"set",current,constraints,sources,criteria?})` records your semantic interpretation. Use only original Human message refs that define the objective (usually `compass_state.input.ref`); never include reads, issue results, or Agent-derived values. Record those separately as evidence.
- `compass_goal` is the only place criteria are defined. Plan and acceptance consume the returned `AC*` IDs. Use `update` to edit selected constraint/criterion IDs from `view:"goal"`; use `set` with a different objective only to replace the Goal.
- After material Human input, reaffirm the Goal before resuming approved work. Unchanged semantics keep the exact approval; a different objective replaces the Goal and resets its work. Use `decide` for material decisions and `checkpoint` for a real recoverable ref.
- Read with `compass_state`: default summary, then `view:goal|plan|acceptance|history|execution` only for what is missing. Reuse returned cursors unchanged; an exact repeat answers `unchanged`. `historyGap` means the delta is bounded, not complete.

## Acceptance

`compass_acceptance({results:[{criterion,status,evidence}]})` records `reported_pass|failed|blocked|inconclusive` for existing criteria. Unknown or duplicate criteria fail without changing state. Your report is not independent verification.

## Plans and Subagents

- A DAG is optional. Choose `executor` explicitly: coupled reasoning stays with `parent`, deterministic batching with `code`, bounded read-only investigation with `subagent`. Every `subagent` task needs `writeScope:"read-only"` and a `dispatchReason` explaining why another context is worth the call.
- `define`/`patch` give you a draft, not authorization. If the receipt contains `prompt`, call `ask_user_question` with that object unchanged. Use `request_approval` when a proposal needs reissuing. Native Pi TUI only. If the DAG is no longer useful, `discard` an inactive plan without changing the Goal.
- After approval, `ready` lists manual work: `parent` uses standalone `compass_context call(taskId)` from root, then committed `return(outcome)`; `code` uses `compass_plan start/done`. Compass dispatches read-only `subagent` tasks itself. Fix and reopen preflight-blocked tasks; never start or redispatch them manually.
- `assess` completed prerequisites with real evidence before dependents unlock. Use `dependsOn` for ordering. Use `fromTasks` only when a parent node must import another parent node’s explicit exports, or `inputRefs` to reuse an exact export. `waiting` explains missing or stale inputs.
- If evidence invalidates the plan, report `throw` with the reason, evidence and known side effects. For native children, check execution state and `cancel` only exact attempts you judge invalidated; a request is not a terminal result. Do not assume rollback.
- `unknown` batches require native Subagent status evidence and `compass_plan({action:"resolve",...})`; never retry them. A task marked done is not Goal acceptance.

## Context

- Search only for missing information: `compass_context_search({query})` for literal keywords, or `{refs}` for exact recovery. Default snippets are short; `view:"handles"` omits text, `view:"details"` adds qualifications.
- Copy refs unchanged; never construct or decode them. Prefer `remember({text,sources,caveats?})` for compact qualified conclusions; `pin({sources})` keeps complete originals visible and costs more.
- All actions are flat: `compass_context({action:"call",...})`. One `pin`/`unpin`/`remember` may accompany sibling tools; everything else must be standalone. `queued` is provisional — the native applied/rejected receipt is authoritative, so never poll.
- `call` opens same-session attention with explicit `capture` (`ref` is read-only, `copy` is private and editable). Finish by returning from the frame; do not report the overall result from inside it. `return` exports only what you name: retained exports keep their lifetime, unexported work releases. A frame is not filesystem rollback.
- `compass_state(view:"retained")` lists retained sources. Edit or drop local Agent-authored memory directly. Complete native `SKILL.md` reads auto-pin in scope; child `unpin` masks inherited pins without changing the parent.
- Use the updated ref from an applied `replace`/`spill`/`move` receipt. Spill verifies a new project artifact before removing context. A frame cannot return with live owned watches: unwatch or `transfer` first.

## Runtime guards

- `runtime_guard({operation:{action,...}})` works before any Goal. Compile only worthwhile mechanical requirements into pure JS, declaring native tools and the exact `input.field` observations needed. Return `{verdict:"pass"|"violation"|"unknown",reason?}`; no I/O, tools or stores.
- `put`/`remove` require the scope revision; reuse receipts instead of rereading every turn. `warn` keeps business results and adds a boundary notice; `block` prevents the observed call. Coverage is the native `tool_call` observation, including Code Mode nested calls — not later plugin rewrites, child processes or OS actions.

On failure, correct the failed precondition from the current receipt instead of inspecting sources. Report unknowns and boundaries honestly. Local tests and Agent reports are neither live provider acceptance nor proof of lower total cost.
