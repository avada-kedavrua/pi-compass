import {
  VALUE_MESSAGE_TYPE, adoptValue, bindingKey, contentVersion, copyValue, currentValue, dataBlocks, isValueMessage, logicalSource, questionnaireContent,
  nativeValueViews, rawMessage as messageOf, releaseFrameValues, renderValue, validateValue, valueContent, valueMessage, writeValue,
} from "./context-values.mjs";
import { analyzeRepeatedSelections, rankVerifiedSources, readObservationIdentity, readOnlyObservation, resolveSource, searchSources, selectSourceRange } from "./context-retrieval.mjs";
import { loadContextArtifact, writeContextArtifact } from "./context-artifacts.mjs";
export { contentVersion } from "./context-values.mjs";

export const CONTEXT_STATE_TYPE = "pi-compass-v2.context";
export const CONTEXT_MESSAGE_TYPE = "pi-compass-v2.context-message";
export const CONTEXT_SCHEMA_VERSION = 4;
const INTENT_TYPE = `${CONTEXT_STATE_TYPE}.intent`;
const MAX_DEPTH = 16;
const MAX_SOURCES = 256;
const MAX_PINS = 64;
const MAX_CONTENT_BYTES = 128 * 1024;
const EXTERNAL_MESSAGES = new Set(["watch-condition", "watch-lost", "subagent-result"]);
const RESERVED_MESSAGES = new Set(["pi-compass-v2.goalrun-state", "pi-compass-v2.goalrun-anchor", "pi-compass-v2.conventions"]);

function fail(message) { throw new Error(`${message} No context changed.`); }
function recoveryRequired(message) {
  throw new Error(`${message} Context projection may have changed; no further Compass mutation was applied. Use Pi tree navigation to return before the intent entry.`);
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function editable(entry) {
  const message = messageOf(entry);
  return Boolean(message && ["user", "assistant", "toolResult", "custom"].includes(message.role) && !RESERVED_MESSAGES.has(message.customType));
}
function ensureText(value, label, maximum = 8_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(`${label} requires 1..${maximum} characters.`);
}
function ensureIds(ids, label = "source IDs") {
  if (!Array.isArray(ids) || ids.length > MAX_SOURCES || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !id)) fail(`${label} must contain at most ${MAX_SOURCES} unique source IDs.`);
}
function ensureContent(content) {
  if (content === undefined || Buffer.byteLength(JSON.stringify(content)) > MAX_CONTENT_BYTES) fail("Context content exceeds 128 KiB; select a smaller unit or spill it.");
}
function ensureVersion(version) {
  if (typeof version !== "string" || !/^[a-f0-9]{24}$/.test(version)) fail("A current source version is required.");
}
function ensureBinding(key, scopes, label, sourceId = null) {
  if (typeof key !== "string" || key.length < 3 || key.length > 129) fail(`Invalid ${label} binding.`);
  const separator = key.indexOf("/");
  const remainder = separator < 0 ? "" : key.slice(separator + 1);
  if (separator < 1 || !scopes.has(key.slice(0, separator)) || !remainder || remainder.includes("/")
    || (sourceId !== null && remainder !== sourceId)) fail(`Invalid ${label} binding.`);
}

export function emptyContextState() {
  return { schemaVersion: CONTEXT_SCHEMA_VERSION, revision: 0, frames: [], pins: [], values: {}, watches: {} };
}

/** Validate current control metadata. Unsupported/corrupt state is never silently reset. */
export function normalizeContextState(raw) {
  if (raw === undefined || raw === null) return emptyContextState();
  if (!object(raw) || raw.schemaVersion !== CONTEXT_SCHEMA_VERSION) fail("Unsupported Compass context schema; open a new session or navigate to a pre-context branch.");
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.frames) || raw.frames.length > MAX_DEPTH || !Array.isArray(raw.pins) || raw.pins.length > MAX_PINS || !object(raw.values) || !object(raw.watches)) fail("Invalid Compass context metadata.");
  const scopes = new Set(["root"]);
  let parent = "root";
  for (const frame of raw.frames) {
    if (!object(frame) || typeof frame.id !== "string" || !frame.id || scopes.has(frame.id) || frame.parent !== parent || typeof frame.boundaryId !== "string" || !(frame.summaryId === null || typeof frame.summaryId === "string")) fail("Invalid frame stack or parent summary reference.");
    if (!Array.isArray(frame.saved) || !Array.isArray(frame.refs) || !Array.isArray(frame.copies)) fail("Invalid frame source lists.");
    const frameScopes = new Set([...scopes, frame.id]);
    ensureIds(frame.saved.map((item) => item.id), "saved source IDs");
    ensureIds(frame.refs.map((item) => item.id), "reference capture IDs");
    ensureIds(frame.copies.map((item) => item.id), "copy capture IDs");
    for (const item of frame.saved) {
      if (typeof item.visible !== "boolean" || !(item.editId === null || typeof item.editId === "string")) fail("Invalid saved source reference.");
      if (item.binding !== null && item.binding !== undefined) ensureBinding(item.binding, scopes, "saved source", item.logicalId ?? item.id);
    }
    for (const item of frame.refs) {
      ensureVersion(item.version);
      ensureBinding(item.key, scopes, "reference capture", item.id);
    }
    for (const item of frame.copies) {
      ensureVersion(item.version);
      if (item.viewKey !== null && item.viewKey !== undefined) ensureBinding(item.viewKey, frameScopes, "copy view", item.id);
    }
    scopes.add(frame.id);
    parent = frame.id;
  }
  for (const pin of raw.pins) {
    if (!object(pin) || typeof pin.id !== "string" || !scopes.has(pin.scope) || !object(raw.values[pin.key]) || (pin.goalVersion !== undefined && (!Number.isSafeInteger(pin.goalVersion) || pin.goalVersion < 1))) fail("Invalid pin owner or value.");
    ensureBinding(pin.key, scopes, "pin", pin.id);
  }
  if (Object.keys(raw.values).length > MAX_SOURCES) fail("Too many active value bindings; retire or spill unused values.");
  for (const [key, head] of Object.entries(raw.values)) {
    ensureBinding(key, scopes, "value");
    validateValue(head);
  }
  for (const watch of Object.values(raw.watches)) {
    if (!object(watch) || !scopes.has(watch.owner)) fail("Invalid watch owner.");
    if (watch.instanceId !== undefined && (typeof watch.instanceId !== "string" || !watch.instanceId.trim())) fail("Invalid native watch identity.");
    for (const field of ["kind", "target", "prompt"]) if (watch[field] !== undefined && typeof watch[field] !== "string") fail(`Invalid native watch ${field}.`);
    if (watch.repeat !== undefined && typeof watch.repeat !== "boolean") fail("Invalid native watch repeat state.");
  }
  return structuredClone({ schemaVersion: raw.schemaVersion, revision: raw.revision, frames: raw.frames, pins: raw.pins, values: raw.values, watches: raw.watches });
}

function draftShape(entry) {
  switch (entry.type) {
    case "custom": return { type: entry.type, customType: entry.customType, data: entry.data };
    case "custom_message": return { type: entry.type, customType: entry.customType, content: entry.content, display: entry.display, details: entry.details };
    case "context_edit": return { type: entry.type, targetId: entry.targetId, replacement: entry.replacement };
    case "compaction": return { type: entry.type, summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId === entry.id ? null : entry.firstKeptEntryId, details: entry.details };
    default: fail(`Unexpected entry ${entry.type} in context commit.`);
  }
}
function verifyCommit(branch, positions, position, commit, state) {
  const start = position - commit.count;
  const base = commit.fromLeafId === null ? -1 : positions.get(commit.fromLeafId) ?? -1;
  const gap = branch.slice(base + 1, start);
  if (!Number.isInteger(commit.count) || commit.count < 1 || start < 0 || base >= start || (commit.fromLeafId !== null && base < 0) || gap.some((entry) => entry.type !== "custom" || [CONTEXT_STATE_TYPE, INTENT_TYPE].includes(entry.customType))) recoveryRequired("Context commit does not match its active-branch baseline.");
  const actual = branch.slice(start, position).map(draftShape);
  if (contentVersion({ entries: actual, state }) !== commit.digest) recoveryRequired("Context proposal or resulting control state was changed or only partially persisted.");
}
export function restoreContextState(branch) {
  let restored = emptyContextState();
  const positions = new Map(branch.map((entry, position) => [entry.id, position]));
  const pending = new Set();
  for (let position = 0; position < branch.length; position++) {
    const entry = branch[position];
    if (entry.type !== "custom") continue;
    if (entry.customType === INTENT_TYPE) pending.add(entry.data.operationId);
    if (entry.customType !== CONTEXT_STATE_TYPE) continue;
    const state = normalizeContextState(entry.data);
    if (entry.data.commit) {
      if (!pending.has(entry.data.commit.operationId)) recoveryRequired("Context commit has no matching operation intent.");
      verifyCommit(branch, positions, position, entry.data.commit, state);
      pending.delete(entry.data.commit.operationId);
    }
    restored = state;
  }
  if (pending.size) recoveryRequired(`Uncommitted context transition ${[...pending].join(", ")}.`);
  return restored;
}
export function contextStateEntry(state) {
  return { type: "custom", customType: CONTEXT_STATE_TYPE, data: normalizeContextState(state) };
}

/** One index per operation; keep raw and active edit views distinct after compaction. */
function sourceIndex(branch, boundary) {
  const byId = new Map();
  const positions = new Map();
  const groups = new Map();
  const calls = new Map();
  const callDetails = new Map();
  const readRequests = new Map();
  for (const [position, entry] of branch.entries()) {
    byId.set(entry.id, entry);
    positions.set(entry.id, position);
    if (entry.customType === VALUE_MESSAGE_TYPE && typeof entry.details?.referenceId === "string") {
      byId.set(entry.details.referenceId, entry);
      positions.set(entry.details.referenceId, position);
      if (entry.details.derived) { byId.set(entry.details.sourceId, entry); positions.set(entry.details.sourceId, position); }
    }
    const message = messageOf(entry);
    if (message?.role === "assistant") {
      const toolCalls = message.content.filter((part) => part.type === "toolCall");
      if (!toolCalls.length) continue;
      const group = { ids: [entry.id], calls: new Set(toolCalls.map((call) => call.id)), results: new Set(), duplicate: false };
      groups.set(entry.id, group);
      for (const call of toolCalls) {
        calls.set(call.id, group);
        if (call.name === "read") callDetails.set(call.id, call);
        else callDetails.delete(call.id);
      }
    }
    if (message?.role === "toolResult") {
      const group = calls.get(message.toolCallId);
      const call = callDetails.get(message.toolCallId);
      if (call) readRequests.set(entry.id, call);
      if (!group) continue;
      group.ids.push(entry.id);
      if (group.results.has(message.toolCallId)) group.duplicate = true;
      group.results.add(message.toolCallId);
      groups.set(entry.id, group);
    }
  }
  const active = new Map();
  const edits = new Map();
  for (const item of boundary?.context?.contextEntries ?? []) {
    if (editable(item.sourceEntry)) active.set(item.sourceEntry.id, item);
    if (item.sourceEntry.type === "context_edit") edits.set(item.sourceEntry.targetId, item.sourceEntry);
  }
  const index = { branch, byId, positions, groups, readRequests, active, edits };
  return { ...index, valueViews: nativeValueViews(index) };
}
function source(index, id) {
  const entry = index.byId.get(id);
  if (!entry) fail(`Unknown or wrong-branch source ${id}.`);
  if (!editable(entry)) fail(`Reserved or non-editable source ${id}.`);
  return entry;
}
function historicalContent(index, id, editId) {
  const entry = source(index, id);
  if (editId === null) return messageOf(entry).content;
  const edit = index.byId.get(editId);
  if (edit?.type !== "context_edit" || edit.targetId !== id) fail(`Stale edit reference ${editId} for ${id}.`);
  return edit.replacement?.content ?? null;
}
function visible(index, id) {
  source(index, id);
  const message = index.active.get(id)?.messages[0];
  if (!message) fail(`Source ${id} is omitted; load it before this operation.`);
  return message;
}
function exchangeClosure(index, ids) {
  const selected = new Set(ids);
  for (const id of ids) {
    const entry = source(index, id);
    const group = index.groups.get(id);
    if (!group && messageOf(entry).role === "toolResult") fail(`Tool result ${id} has no matching tool call.`);
    if (!group) continue;
    if (group.duplicate || group.calls.size !== group.results.size) fail(`Tool exchange ${id} is incomplete or duplicated.`);
    for (const member of group.ids) selected.add(member);
  }
  if (selected.size > MAX_SOURCES) fail("The complete tool exchange exceeds the source bound.");
  return selected;
}
function snapshot(state, index, turnIds) {
  const saved = [];
  for (const [id, item] of index.active) {
    if (turnIds.has(id)) continue;
    const message = item.messages[0];
    const logicalId = logicalSource(index, id);
    const key = bindingKey(state, index, logicalId);
    const view = index.valueViews.get(key);
    const ownsValue = message && (view ? view.sourceEntry.id === id : logicalId === id);
    const head = ownsValue ? state.values[key] : null;
    saved.push({ id, editId: index.edits.get(id)?.id ?? null, visible: Boolean(message), binding: head ? key : null, valueState: head ? contentVersion(head) : null, logicalId });
  }
  if (saved.length > MAX_SOURCES) fail("Too many active sources; compact or spill before entering a frame.");
  return saved;
}
function nativeEdit(targetId, content) { return { type: "context_edit", targetId, replacement: content === null ? null : { content: structuredClone(content) } }; }
function nativeMessage(content, details = {}) { return { type: "custom_message", customType: CONTEXT_MESSAGE_TYPE, content: structuredClone(content), display: false, details }; }
function nativeCheckpoint(summary, firstKeptEntryId, operationId) { return { type: "compaction", summary, firstKeptEntryId, details: { compassOperation: operationId } }; }
function latestSummary(boundary) {
  return boundary.context.contextEntries.find((item) => item.sourceEntry.type === "compaction" && item.messages.some((message) => message.role === "compactionSummary"))?.sourceEntry ?? null;
}
function operationFromBoundary(boundary, toolName) {
  const calls = boundary.message?.role === "assistant" ? boundary.message.content.filter((part) => part.type === "toolCall") : [];
  const own = calls.filter((call) => call.name === toolName);
  if (!own.length) return null;
  if (calls.length !== 1 || boundary.toolResults?.length !== 1) fail("Context mutation must be a standalone tool call, not part of a parallel tool batch.");
  const result = boundary.toolResults[0];
  if (result.isError) return null;
  if (result.toolCallId !== own[0].id || !object(result.details?.contextOperation)) return null;
  return { ...result.details.contextOperation, callId: own[0].id, id: boundary.messageEntryId };
}

function planCall({ next, index, boundary, operation, turnIds }) {
  if (next.frames.length >= MAX_DEPTH) fail("Context frame depth limit (16) reached.");
  ensureText(operation.task, "Frame task", 4_000);
  const captures = operation.capture ?? [];
  ensureIds(captures.map((item) => item.id), "capture IDs");
  const refs = [];
  const copies = [];
  const inputs = [];
  for (const item of captures) {
    if (!["ref", "copy"].includes(item.mode)) fail("Capture mode must be ref or copy.");
    source(index, item.id);
    const value = currentValue(next, index, item.id, { key: item.binding });
    if (value.version !== item.version) fail(`Stale capture ${item.id}.`);
    adoptValue(next, value);
    if (item.mode === "ref") { refs.push({ id: value.id, key: value.key, version: value.version }); inputs.push(value.nativeId); }
    else {
      const key = copyValue(next, value, operation.id);
      const reuse = ["user", "custom"].includes(value.message.role)
        && (!value.head.rendered || next.values[key].kind === value.head.kind);
      copies.push({ id: value.id, version: value.version, viewId: reuse ? value.nativeId : null, viewKey: value.viewKey, key, materialize: !reuse });
      if (reuse) inputs.push(value.nativeId);
    }
  }
  const saved = snapshot(next, index, turnIds);
  const summary = latestSummary(boundary);
  const frame = { id: operation.id, parent: next.frames.at(-1)?.id ?? "root", boundaryId: boundary.messageEntryId, saved, refs, copies: copies.map(({ materialize: _materialize, key: _key, ...copy }) => copy), summaryId: summary?.id ?? null };
  for (const pin of next.pins) {
    const view = index.valueViews.get(pin.key) ?? index.active.get(pin.id);
    if (view?.messages.length) inputs.push(view.sourceEntry.id);
  }
  const kept = exchangeClosure(index, inputs);
  for (const id of kept) visible(index, id);
  next.frames.push(frame);
  const entries = summary ? [nativeCheckpoint("", saved[0]?.id ?? null, operation.id)] : [];
  for (const [id, item] of index.active) if (item.messages.length && (turnIds.has(id) || !kept.has(id))) entries.push(nativeEdit(id, null));
  for (const copy of copies.filter((item) => item.materialize)) {
    const head = next.values[copy.key];
    entries.push(valueMessage({ id: copy.id, key: copy.key, head, content: valueContent(index, head) }));
  }
  entries.push(nativeMessage(`Frame ${frame.id}; context revision ${next.revision + 1}.\nTask: ${operation.task}\nInputs: ref=${refs.map((ref) => ref.id).join(", ") || "none"}; private copy=${copies.map((copy) => copy.id).join(", ") || "none"}. Return explicitly; exports default to none. Environment effects remain.`, { frame: frame.id, action: "call" }));
  return entries;
}
function external(entry) {
  const message = messageOf(entry);
  return message?.role === "user" || (message?.role === "custom" && EXTERNAL_MESSAGES.has(message.customType));
}
function planReturn({ next, index, boundary, operation }) {
  const frame = next.frames.at(-1);
  if (!frame) fail("No active context frame.");
  const watches = Object.entries(next.watches).filter(([, watch]) => watch.owner === frame.id).map(([id]) => id);
  if (watches.length) fail(`Frame owns active watches: ${watches.join(", ")}. Cancel or transfer them before returning.`);
  ensureIds(operation.exportIds ?? [], "export IDs");
  const boundaryPosition = index.positions.get(frame.boundaryId);
  if (boundaryPosition === undefined) fail("Frame boundary is not on the active branch.");
  const savedIds = new Set(frame.saved.map((item) => item.id));
  const owned = index.branch.slice(boundaryPosition).filter(editable);
  const summary = frame.summaryId === null ? null : index.byId.get(frame.summaryId);
  if (frame.summaryId !== null && summary?.type !== "compaction") fail("Parent summary is unavailable on this branch.");
  const firstKeptEntryId = frame.saved[0]?.id ?? summary?.id ?? owned.find(external)?.id ?? null;
  const entries = latestSummary(boundary)?.id !== frame.summaryId
    ? [nativeCheckpoint(summary?.summary ?? "", firstKeptEntryId, operation.id)] : [];
  // Iterate raw owned entries, not just the currently visible tail: compaction can hide local process.
  for (const entry of owned) if (!savedIds.has(entry.id) && !external(entry)) entries.push(nativeEdit(entry.id, null));
  for (const saved of frame.saved) {
    const head = saved.binding ? next.values[saved.binding] : null;
    const changed = head && contentVersion(head) !== saved.valueState;
    const sharedPin = changed && next.pins.some((pin) => pin.id === saved.logicalId && pin.key !== saved.binding);
    const raw = index.byId.get(saved.id);
    const forkedView = changed && (sharedPin || (raw.customType === VALUE_MESSAGE_TYPE && raw.details.key !== saved.binding));
    const value = head ? { id: saved.logicalId, key: saved.binding, head, content: valueContent(index, head) } : null;
    let content = saved.visible ? historicalContent(index, saved.id, saved.editId) : null;
    if (changed) {
      if (forkedView) content = sharedPin ? content : null;
      else content = renderValue(value);
    }
    entries.push(nativeEdit(saved.id, content));
    if (forkedView) entries.push(valueMessage(value));
    if (changed && !forkedView) {
      const owner = next.frames.find((item) => item.id === saved.binding.split("/")[0]);
      const copy = owner?.copies.find((item) => item.id === saved.logicalId);
      if (copy) copy.viewKey = saved.binding;
    }
  }
  for (const [number, id] of (operation.exportIds ?? []).entries()) {
    const value = currentValue(next, index, id);
    ensureContent(value.content);
    entries.push(sourceDataDraft(next, operation, { ...value, caveats: value.head.caveats, provenance: [...new Set([...value.head.sources, value.head.entryId])], readStatus: value.head.readStatus }, "export", number, frame.parent));
  }
  if (operation.result !== undefined && operation.result !== "") {
    ensureText(operation.result, "Return value");
    entries.push(nativeMessage(`Return from ${frame.id}:\n${operation.result}`, { frame: frame.id, action: "result" }));
  }
  next.frames.pop();
  next.pins = next.pins.filter((pin) => pin.scope !== frame.id);
  releaseFrameValues(next, frame.id);
  entries.push(nativeMessage(`Returned from ${frame.id}; context revision ${next.revision + 1}. Local process released; environment effects remain.`, { frame: frame.id, action: "return" }));
  return entries;
}
function writeView(state, value, head, content) {
  const executedCall = value.message.role === "assistant" && value.message.content.some((part) => part.type === "toolCall");
  if (value.key === value.viewKey && !executedCall) return [nativeEdit(value.nativeId, renderValue(value, content, head))];
  const protectedView = executedCall || state.pins.some((pin) => pin.key !== value.key && pin.id === value.id);
  return [...(protectedView ? [] : [nativeEdit(value.nativeId, null)]), valueMessage(value, content, head)];
}
function planPins({ next, index, operation }) {
  ensureIds(operation.ids);
  if (!operation.ids.length) fail("Select sources to pin or unpin.");
  const scope = operation.scope ?? next.frames.at(-1)?.id ?? "root";
  if (!["root", ...next.frames.map((frame) => frame.id)].includes(scope)) fail(`Pin scope ${scope} is not active.`);
  const entries = [];
  for (const id of operation.ids) {
    source(index, id);
    const value = currentValue(next, index, id, { key: operation.binding, allowHidden: operation.action === "unpin" });
    if (operation.action === "pin") {
      if (operation.kind === "skill" && (value.head.field !== "content" || value.key !== value.viewKey || value.message?.role !== "toolResult" || value.message.toolName !== "read" || value.nativeId !== id || value.head.readStatus?.sourceId !== id || value.head.readStatus?.status !== "complete" || value.head.readStatus.fullSkillFile !== true || value.head.readStatus.payloadVersion !== value.head.version)) fail("Skill activation requires the exact original payload of a successful, complete native Skill-file read; loaded, copied, failed, truncated, or derived content is not enough.");
      const scopes = ["root", ...next.frames.map((frame) => frame.id)];
      if (scopes.indexOf(scope) < scopes.indexOf(value.key.split("/")[0])) fail("A local value cannot outlive its binding; explicitly export it before pinning it in a parent scope.");
      const head = adoptValue(next, value);
      if (operation.kind !== undefined) head.kind = operation.kind;
      if (operation.caveats !== undefined) head.caveats = operation.caveats;
      // Render a qualified view, retaining the immutable raw source/body version.
      // This gives outgoing requests a complete source/version/caveat envelope;
      // it does not claim a new observation or rewrite the original Pi record.
      head.rendered = true;
      head.handling = "active";
      delete head.handlingReason;
      validateValue(head);
      entries.push(...writeView(next, value, head, value.content));
      next.pins = next.pins.filter((pin) => pin.key !== value.key || pin.scope !== scope);
      next.pins.push({ id: value.id, key: value.key, scope, ...(operation.lifetime === "session" ? {} : { goalVersion: operation.goalVersion ?? 1 }) });
    } else next.pins = next.pins.filter((pin) => pin.key !== value.key || pin.scope !== scope);
  }
  if (next.pins.length > MAX_PINS) fail("At most 64 sources may be pinned.");
  return entries;
}
function planHandling({ next, index, operation }) {
  ensureIds(operation.ids);
  if (operation.ids.length !== 1 || !["active", "handled", "retired"].includes(operation.handling)) fail("Mark requires one source and an explicit handling state.");
  ensureText(operation.reason, "Handling rationale", 600);
  const value = currentValue(next, index, operation.ids[0], { key: operation.binding, allowHidden: true });
  ensureVersion(operation.version);
  if (value.version !== operation.version) fail("Handling source version is stale.");
  const head = adoptValue(next, value);
  head.handling = operation.handling;
  head.handlingReason = operation.reason;
  head.rendered = true;
  if (operation.handling === "retired") next.pins = next.pins.filter((pin) => pin.key !== value.key);
  return value.message ? writeView(next, value, head, value.content) : [];
}
function assertWritableValue(state, value) {
  const frame = state.frames.at(-1);
  const owner = value.key.split("/")[0];
  if (frame && owner !== frame.id && !frame.refs.some((ref) => ref.id === value.id && ref.key === value.key)) fail(`Outer value ${value.id} requires an explicit ref capture.`);
  if (state.pins.some((pin) => pin.key === value.key)) fail(`Pinned source ${value.id} must be explicitly unpinned first.`);
}
function planEdits({ next, index, operation, boundary }) {
  ensureIds(operation.ids);
  if (!operation.ids.length) fail("Select sources to edit.");
  if (operation.action === "replace") {
    if (operation.ids.length !== 1) fail("Replacement requires exactly one source.");
    source(index, operation.ids[0]);
    const value = currentValue(next, index, operation.ids[0], { key: operation.binding });
    assertWritableValue(next, value);
    ensureVersion(operation.version);
    if (value.version !== operation.version) fail(`Source ${value.id} changed since selection.`);
    const head = writeValue(next, index, value, operation, boundary.toolResultEntryIds[0]);
    ensureContent(renderValue(value, operation.content, head));
    // Protocol-sensitive copies materialize on capture; generic copies share
    // their source until the first write creates a private data view.
    return writeView(next, value, head, operation.content);
  }
  const selected = operation.ids.map((id) => {
    source(index, id);
    const value = currentValue(next, index, id, { key: operation.binding });
    assertWritableValue(next, value);
    return value;
  });
  const byNativeId = new Map(selected.map((value) => [value.nativeId, value]));
  const versions = new Map((operation.versions ?? []).map((item) => [item.id, item.version]));
  const ids = exchangeClosure(index, selected.map((value) => value.nativeId));
  const entries = [];
  for (const nativeId of ids) {
    const id = logicalSource(index, nativeId);
    const value = byNativeId.get(nativeId) ?? currentValue(next, index, id);
    assertWritableValue(next, value);
    if (value.head.readOnly && (value.head.kind === "human" || messageOf(source(index, id)).role === "user")) fail("Human messages cannot be dropped.");
    if (next.pins.some((pin) => pin.key === value.key)) fail(`Pinned source ${id} must be explicitly unpinned first.`);
    const borrowed = next.frames.at(-1)?.refs.some((ref) => ref.id === id);
    if (borrowed) fail(`Referenced outer slot ${id} cannot be dropped.`);
    ensureVersion(versions.get(id));
    if (value.version !== versions.get(id)) fail(`Source ${id} changed since selection.`);
    entries.push(nativeEdit(nativeId, null));
    delete next.values[value.key];
  }
  for (const value of selected) {
    const owner = next.frames.find((frame) => frame.id === value.key.split("/")[0]);
    if (owner) owner.copies = owner.copies.filter((copy) => copy.id !== value.id);
  }
  return entries;
}
function sourceDataDraft(state, operation, selected, action, number = 0, owner = state.frames.at(-1)?.id ?? "root") {
  const content = dataBlocks(selected.content);
  if (!content.length) fail("Selection has no displayable source data; select a text or image part.");
  const id = `${operation.id}:${action}:${number}`;
  const head = {
    entryId: id, field: "snapshot", version: contentVersion(content), kind: "memory", readOnly: false, rendered: true, handling: "active",
    caveats: [...selected.caveats], sources: [...selected.provenance],
    ...(selected.readStatus ? { readStatus: { ...structuredClone(selected.readStatus), fullSkillFile: selected.readStatus.fullSkillFile === true && !selected.range && contentVersion(content) === selected.readStatus.payloadVersion } } : {}),
    origin: { id: selected.id, version: selected.version, range: selected.range ?? null },
  };
  const draft = valueMessage({ id, key: `${owner}/${id}`, head }, content);
  Object.assign(draft.details, { action, derived: true, referenceId: id, origin: head.origin });
  return draft;
}
function cutTextRange(content, range) {
  const part = range.part ?? 0;
  const isString = typeof content === "string";
  const blocks = isString ? [{ type: "text", text: content }] : structuredClone(content);
  const block = blocks[part];
  if (!block || block.type !== "text") fail("Selected-range movement requires one native text part.");
  const lines = block.text.split("\n");
  const start = range.startLine ?? 1;
  const end = range.endLine ?? lines.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) fail("Requested line range is stale or out of bounds.");
  const selected = lines.slice(start - 1, end).join("\n");
  const remaining = [...lines.slice(0, start - 1), ...lines.slice(end)].join("\n");
  if (!remaining.trim()) fail("Range movement cannot remove the entire source; use drop only for an eligible whole working value.");
  if (isString) return { selected, remaining, range: { part: 0, startLine: start, endLine: end } };
  blocks[part] = { ...block, text: remaining };
  return { selected: [{ ...block, text: selected }], remaining: blocks, range: { part, startLine: start, endLine: end } };
}

export async function prepareContextOperation({ state, branch, boundary, operation, projectRoot }) {
  if (operation.action === "move" && operation.range) {
    ensureIds(operation.ids);
    if (operation.ids.length !== 1) fail("Selected-range movement requires exactly one versioned source.");
    const index = sourceIndex(branch, boundary);
    const selected = resolveSource(index, state, { id: operation.ids[0], binding: operation.binding, version: operation.version }, operation.sourceScope ?? "all");
    const sourceEntry = index.byId.get(selected.id);
    if (selected.head?.kind === "skill") fail("Active Skill content is not eligible for relocation.");
    if (selected.role === "assistant" && sourceEntry.message?.content?.some?.((part) => part.type === "toolCall")) fail("Assistant tool-call records are immutable.");
    if (!(["assistant", "toolResult"].includes(selected.role))) fail("Selected-range movement is limited to Agent-authored text or a complete read-only tool result; Human messages are immutable.");
    if (selected.role === "toolResult") {
      const observation = readOnlyObservation(index, selected.id);
      if (!observation || observation.payloadVersion !== selected.version) fail("Only successful, untruncated native read results at the exact observed payload version can be range-relocated.");
      exchangeClosure(index, [selected.id]);
    }
    const cut = cutTextRange(selected.content, operation.range);
    return { operation: { ...operation, range: cut.range, selectedRange: cut.selected, remaining: cut.remaining, preserveSource: selected.role === "toolResult" } };
  }
  if (!["spill", "load"].includes(operation.action)) return { operation };
  ensureIds(operation.ids);
  if (operation.ids.length !== 1) fail("Artifact operations require exactly one versioned source.");
  const index = sourceIndex(branch, boundary);
  const selected = resolveSource(index, state, { id: operation.ids[0], binding: operation.binding, version: operation.version }, operation.sourceScope ?? "all");
  if (operation.action === "spill") {
    if (operation.range) fail("Load a range as a separate data copy before spilling it; do not remove an unselected remainder.");
    const value = currentValue(state, index, selected.id, { key: selected.binding });
    assertWritableValue(state, value);
    if (value.head.readOnly) fail("Spill a loaded data copy, not an original Human instruction or executed call.");
    const written = await writeContextArtifact({ projectRoot, relativePath: operation.path, source: selected.id, binding: selected.binding, version: selected.version, range: null, purpose: operation.purpose, caveats: selected.caveats, provenance: selected.provenance, content: selected.content });
    if (!written.ok) fail(`${written.error}${written.possibleOrphan ? ` Artifact may remain at ${written.possibleOrphan.path}; no filesystem rollback was attempted.` : ""}`);
    const artifact = written.artifact;
    const pointer = `Context artifact ${artifact.path}; source ${selected.id} @${selected.version}; SHA-256 ${artifact.sha256}; ${artifact.bytes} bytes. Purpose: ${artifact.purpose}. Use compass_context load to verify and recover; availability is not a successful Goal check.`;
    return { operation: { ...operation, artifact, pointer } };
  }
  const reference = selected.head?.field === "operation" ? index.byId.get(selected.head.entryId)?.message?.details?.contextOperation : null;
  if (reference?.action !== "spill") return { operation };
  const artifact = reference.artifact;
  const loaded = await loadContextArtifact({ projectRoot, relativePath: artifact.path, artifact, source: artifact.source, binding: artifact.binding, version: artifact.version, range: artifact.range, purpose: artifact.purpose });
  const selection = selectSourceRange(loaded.content, operation.range);
  const content = dataBlocks(selection.content);
  return {
    operation: { ...operation, recovery: { artifact, payloadVersion: contentVersion(content), range: selection.range } },
    content: [{ type: "text", text: "Verified artifact data queued for a native context copy; this is not a new Human instruction or acceptance result." }, ...content],
  };
}
function planLoad({ next, index, operation, boundary }) {
  ensureIds(operation.ids);
  if (operation.ids.length !== 1) fail("Load requires exactly one versioned source.");
  let selected = resolveSource(index, next, { id: operation.ids[0], binding: operation.binding, version: operation.version, range: operation.recovery ? undefined : operation.range }, operation.sourceScope ?? "all");
  if (operation.recovery) {
    const original = index.byId.get(selected.head?.entryId)?.message?.details?.contextOperation;
    if (original?.action !== "spill" || contentVersion(original.artifact) !== contentVersion(operation.recovery.artifact)) fail("Artifact receipt changed before native load commit.");
    const content = boundary.toolResults[0].content.slice(1);
    if (contentVersion(content) !== operation.recovery.payloadVersion) fail("Verified artifact payload changed before commit.");
    selected = { ...selected, content, version: original.artifact.version, caveats: original.artifact.caveats, provenance: original.artifact.provenance, range: operation.recovery.range ?? null };
  }
  const draft = sourceDataDraft(next, operation, selected, "load");
  return [...(operation.recovery ? [nativeEdit(boundary.toolResultEntryIds[0], [{ type: "text", text: `Verified artifact payload follows as ${draft.details.sourceId} @${draft.details.version}.` }])] : []), draft];
}
function planSpill({ next, index, operation, boundary }) {
  ensureIds(operation.ids);
  if (operation.ids.length !== 1 || !operation.artifact || typeof operation.pointer !== "string") fail("A verified artifact receipt is required before source removal.");
  const value = currentValue(next, index, operation.ids[0], { key: operation.binding });
  assertWritableValue(next, value);
  if (value.head.readOnly || value.version !== operation.version || operation.artifact.version !== value.version || operation.artifact.source !== value.id) fail("Spill source changed or is read-only; the artifact may remain, but context was not removed.");
  const head = {
    entryId: boundary.toolResultEntryIds[0], field: "operation", version: contentVersion(operation.pointer), kind: "memory",
    readOnly: false, rendered: true, handling: "active", caveats: [...value.head.caveats], sources: [...value.head.sources],
    ...(value.head.readStatus ? { readStatus: structuredClone(value.head.readStatus) } : {}),
  };
  next.values[value.key] = head;
  return writeView(next, value, head, operation.pointer);
}
function verifyMoveComparison(index, state, operation) {
  if (operation.verifiedAgainst === undefined) return null;
  if (operation.action !== "move" || operation.range || operation.ids?.length !== 1 || !operation.verifiedAgainst || typeof operation.verifiedAgainst !== "object") fail("verifiedAgainst is supported only for one explicit whole-read relocation.");
  const sourceId = operation.ids[0];
  const sourceVersion = operation.version;
  const comparison = operation.verifiedAgainst;
  if (comparison.range !== undefined) fail("Verified coalescing requires the complete comparison read payload; use search compare for selected-range analysis without removing its remainder.");
  ensureIds([comparison.id]);
  const sourceObservation = readOnlyObservation(index, sourceId);
  const comparedObservation = readOnlyObservation(index, comparison.id);
  if (!sourceObservation || !comparedObservation) fail("Read relocation requires successful, untruncated read results with complete paired exchanges.");
  ensureVersion(sourceVersion);
  ensureVersion(comparison.version);
  if (sourceVersion !== sourceObservation.payloadVersion || comparison.version !== comparedObservation.payloadVersion) fail("Read relocation source or comparison payload version is stale.");
  resolveSource(index, state, comparison, operation.sourceScope ?? "all");
  if (sourceObservation.path !== comparedObservation.path) fail("Read relocation sources do not identify the same canonical path.");
  exchangeClosure(index, [sourceId]);
  exchangeClosure(index, [comparison.id]);
  const candidates = new Map([
    [sourceId, { id: sourceId, version: sourceObservation.payloadVersion }],
    [comparison.id, { id: comparison.id, version: comparedObservation.payloadVersion }],
  ]);
  let afterSource = false;
  let scannedAfterSource = 0;
  for (const id of index.readRequests.keys()) {
    if (id === sourceId) { afterSource = true; continue; }
    if (!afterSource || index.readRequests.get(id)?.name !== "read") continue;
    if (++scannedAfterSource > 256) fail("Too many later read results to verify relocation within the bounded safety scan; no context changed.");
    if (candidates.has(id)) continue;
    const identity = readObservationIdentity(index, id);
    if (identity?.path !== sourceObservation.path) continue;
    const observation = readOnlyObservation(index, id);
    if (!observation) fail(`Later same-path read ${id} is not complete and successful${identity.revision ? ` (native revision ${identity.revision})` : ""}; relocation freshness is unknown.`);
    candidates.set(id, { id, version: observation.payloadVersion });
  }
  if (candidates.size > 16) fail("Too many read observations exist for this path to verify one relocation safely; no context changed.");
  const samePath = [...candidates.values()];
  const report = analyzeRepeatedSelections(index, state, samePath, operation.sourceScope ?? "all");
  const sourcePosition = index.positions.get(sourceId);
  const newerConflict = report.changed.find((item) => (item.firstId === sourceId && index.positions.get(item.secondId) > sourcePosition) || (item.secondId === sourceId && index.positions.get(item.firstId) > sourcePosition));
  if (newerConflict) fail(`Read relocation rejected: later changed-file or payload evidence conflicts (${newerConflict.reason}).`);
  const pair = (item) => (item.firstId === sourceId && item.secondId === comparison.id) || (item.secondId === sourceId && item.firstId === comparison.id);
  const exact = report.exact.find((item) => pair(item) && item.relocateId === sourceId);
  if (exact) return { kind: "exact", ...exact };
  const subset = report.subsets.find((item) => pair(item) && item.relocateId === sourceId && item.supersetId === sourceId);
  if (subset) return { kind: "subset", ...subset };
  const unknown = report.unknown.find(pair);
  if (unknown) fail(`Read relocation rejected: ${unknown.reason}`);
  if (report.changed.length) fail(`Read relocation rejected: changed-file or payload evidence conflicts (${report.changed[0].reason}).`);
  fail("Read relocation requires an exact repeated range or a revision-verified covered subset; no source information was changed.");
}
function planMove({ next, index, operation, boundary, moveComparison }) {
  ensureIds(operation.ids);
  if (!operation.ids.length) fail("Select versioned source values to move to the append end.");
  if (operation.range) {
    if (operation.ids.length !== 1 || operation.selectedRange === undefined || operation.remaining === undefined) fail("Selected-range move requires a freshly verified source range.");
    const id = operation.ids[0];
    const value = currentValue(next, index, id, { key: operation.binding });
    assertWritableValue(next, value);
    ensureVersion(operation.version);
    if (value.version !== operation.version) fail(`Source ${id} changed since selection.`);
    const preserveSource = value.message?.role === "toolResult";
    if (value.head.kind === "skill") fail("Active Skill content is not eligible for relocation.");
    const observation = preserveSource ? readOnlyObservation(index, value.nativeId) : null;
    if (preserveSource && (!observation || observation.payloadVersion !== value.version)) fail("Only successful, untruncated native read results at the exact observed payload version can be range-relocated.");
    if (value.head.readOnly && !preserveSource) fail("This value is read-only and cannot be range-moved.");
    if (!preserveSource && (value.message?.role !== "assistant" || value.message.content?.some?.((part) => part.type === "toolCall"))) fail("Human messages and executed call records cannot be range-moved.");
    if (operation.preserveSource !== preserveSource) fail("Prepared source-preservation mode does not match the selected source.");
    if (preserveSource) exchangeClosure(index, [value.nativeId]);
    const verifiedCut = cutTextRange(value.content, operation.range);
    if (contentVersion(verifiedCut.selected) !== contentVersion(operation.selectedRange) || (!preserveSource && contentVersion(verifiedCut.remaining) !== contentVersion(operation.remaining))) fail(`Selected range payload changed after preparation for source ${id}.`);
    const moved = sourceDataDraft(next, operation, {
      id: value.id, version: value.version, range: operation.range, content: operation.selectedRange,
      caveats: value.head.caveats, provenance: [...new Set([...value.head.sources, value.id])], readStatus: value.head.readStatus,
    }, "move-range");
    if (preserveSource) return [moved];
    const head = {
      entryId: boundary.toolResultEntryIds[0], field: "operation", version: contentVersion(operation.remaining), kind: value.head.kind,
      readOnly: false, rendered: true, handling: value.head.handling, caveats: [...value.head.caveats], sources: [...value.head.sources],
    };
    next.values[value.key] = head;
    const remainder = renderValue({ ...value, head }, operation.remaining, head);
    return [nativeEdit(value.nativeId, remainder), moved];
  }
  const versions = new Map((operation.versions ?? []).map((item) => [item.id, item.version]));
  const entries = [];
  let companion = null;
  if (moveComparison) {
    companion = currentValue(next, index, operation.verifiedAgainst.id, { key: operation.verifiedAgainst.binding });
    assertWritableValue(next, companion);
    if (companion.message?.role !== "toolResult" || companion.nativeId !== companion.id || companion.version !== operation.verifiedAgainst.version) fail("The comparison must be the exact visible original read result, not an edited or private view.");
    if (next.pins.some((pin) => pin.id === companion.id || pin.id === operation.ids[0])) fail("Explicitly unpin both covered sources before verified read coalescing.");
  }
  for (const id of operation.ids) {
    const value = currentValue(next, index, id, { key: operation.binding });
    assertWritableValue(next, value);
    if (value.head.kind === "skill") fail("Active Skill content is not eligible for relocation.");
    if (value.message?.role === "toolResult") {
      exchangeClosure(index, [value.nativeId]);
      const observation = readOnlyObservation(index, value.nativeId);
      if (!observation || observation.payloadVersion !== value.version) fail("Move only a verified successful read result at its exact observed payload version; other executed results remain immutable.");
    }
    if (value.head.readOnly) fail("Move a loaded data copy, not an original Human instruction or executed call.");
    const expected = operation.ids.length === 1 ? operation.version ?? versions.get(id) : versions.get(id);
    ensureVersion(expected);
    if (value.version !== expected) fail(`Source ${id} changed since selection.`);
    const head = adoptValue(next, value);
    head.rendered = true;
    if (companion) {
      if (!head.sources.includes(companion.id)) head.sources.push(companion.id);
      if (moveComparison.kind === "subset") head.caveats = [...new Set([...head.caveats, `Earlier superset retained; only lines ${moveComparison.range.startLine}-${moveComparison.range.endLine} were refreshed. Outside-subset data remains unrefreshed.`])];
      validateValue(head);
    }
    const protectedView = next.pins.some((pin) => pin.id === value.id && pin.key !== value.key);
    if (!protectedView) {
      const pointer = value.message.role === "toolResult" ? [{ type: "text", text: `Context relocation pointer, not original tool output: source ${value.id} @${value.version}; complete payload follows as retained data.` }] : null;
      if (pointer) head.pointerVersion = contentVersion(pointer);
      entries.push(nativeEdit(value.nativeId, pointer));
    }
    entries.push(valueMessage(value, value.content, head));
  }
  if (companion) {
    const head = adoptValue(next, companion);
    const pointer = [{ type: "text", text: `Covered read pointer, not original tool output: source ${companion.id} @${companion.version}; verified ${moveComparison.kind} payload follows as source ${operation.ids[0]} @${operation.version}. The raw read exchange is unchanged.` }];
    head.rendered = true;
    head.pointerVersion = contentVersion(pointer);
    entries.push(nativeEdit(companion.nativeId, pointer));
  }
  return entries;
}
function transitionEntries(state, branch, boundary, operation, entries) {
  const intent = { type: "custom", customType: INTENT_TYPE, data: { operationId: operation.id, baseRevision: state.revision - 1 } };
  const all = [...(boundary.entries ?? []), intent, ...entries];
  const persisted = contextStateEntry(state);
  persisted.data.commit = { operationId: operation.id, fromLeafId: branch.at(-1)?.id ?? null, count: all.length, digest: contentVersion({ entries: all.map(draftShape), state: persisted.data }) };
  return [intent, ...entries, persisted];
}

export function planContextBoundary({ state: input, branch, boundary, toolName = "compass_context" }) {
  const operation = operationFromBoundary(boundary, toolName);
  if (!operation || operation.action === "search") return null;
  const next = normalizeContextState(input);
  if (operation.expectedRevision !== next.revision) fail(`Stale context revision ${operation.expectedRevision}; current revision is ${next.revision}.`);
  if ((boundary.entries ?? []).some((entry) => entry.type !== "custom")) fail("Another extension proposed context changes; run this context operation at a separate boundary.");
  const args = { next, index: sourceIndex(branch, boundary), boundary, operation, turnIds: new Set([boundary.messageEntryId, ...boundary.toolResultEntryIds]) };
  if (operation.verifiedAgainst !== undefined && operation.action !== "move") fail("verifiedAgainst is valid only for action=move.");
  args.moveComparison = operation.action === "move" ? verifyMoveComparison(args.index, next, operation) : null;
  let entries;
  switch (operation.action) {
    case "call": entries = planCall(args); break;
    case "return": entries = planReturn(args); break;
    case "transfer": {
      const transferred = planWatchTransfer(args);
      entries = [nativeMessage(`Native watch ownership transferred; watches: ${transferred.join(", ")}; scope: ${operation.watchScope ?? operation.scope}.`, { action: "transfer", watches: transferred, scope: operation.watchScope ?? operation.scope })];
      break;
    }
    case "pin": case "unpin": entries = planPins(args); break;
    case "replace": case "drop": entries = planEdits(args); break;
    case "load": entries = planLoad(args); break;
    case "move": entries = planMove(args); break;
    case "spill": entries = planSpill(args); break;
    case "mark": entries = planHandling(args); break;
    default: fail(`Unknown context action ${operation.action}.`);
  }
  next.revision += 1;
  const references = entries.filter((entry) => entry.type === "custom_message" && entry.customType === VALUE_MESSAGE_TYPE && entry.details.derived).map((entry) => ({ id: entry.details.sourceId, binding: entry.details.key, version: entry.details.version }));
  if (!["call", "return"].includes(operation.action) || references.length) {
    const movedEntry = operation.action === "move" ? args.index.byId.get(operation.ids?.[0]) : null;
    const movedRole = movedEntry ? messageOf(movedEntry)?.role : null;
    const comparison = args.moveComparison;
    const comparisonText = comparison?.kind === "exact"
      ? ` Verified exact repeat of ${comparison.firstId} and ${comparison.secondId} at ${comparison.path}; the earlier payload was relocated and the covered companion became a qualified pointer.`
      : comparison?.kind === "subset"
        ? ` Verified subset of ${comparison.path} on file revision ${comparison.fileRevision}; the full prior superset was relocated, the covered subset became a qualified pointer, and content outside lines ${comparison.range.startLine}-${comparison.range.endLine} remains unrefreshed.`
        : "";
    const change = operation.action !== "move" ? "" : operation.range
      ? movedRole === "toolResult"
        ? " Selected verified read lines were appended as qualified data; the original call/result and larger source remain unchanged."
        : " Selected Agent-authored lines were removed from the future view and appended as qualified data; the raw message remains unchanged."
      : movedRole === "toolResult"
        ? " The complete verified read payload was relocated to the append end; its original call/result pair remains present with a projection pointer."
        : " The selected working value was moved to the append end.";
    entries.push(nativeMessage(`Context ${operation.action} applied; revision ${next.revision}. Sources: ${(operation.ids ?? []).join(", ")}.${change}${comparisonText}${references.length ? ` Values: ${JSON.stringify(references)}` : ""}`, { action: operation.action, revision: next.revision, references, ...(operation.action === "move" ? { sourceIds: [...(operation.ids ?? [])], range: operation.range ?? null, rawExchangePreserved: movedRole === "toolResult", rawSourcePreserved: movedRole !== "toolResult", ...(comparison ? { relocationComparison: comparison, coalescedSourceIds: [operation.verifiedAgainst.id] } : {}) } : {}) }));
  }
  return { state: next, entries: transitionEntries(next, branch, boundary, operation, entries), continue: ["call", "return"].includes(operation.action) && boundary.outcome === "completed" };
}

function activeWatchScopes(state) {
  return new Set(["root", ...state.frames.map((frame) => frame.id)]);
}
function watchOwner(state, details) {
  const scope = typeof details?.frameScope === "string" && details.frameScope.trim()
    ? details.frameScope.trim()
    : state.frames.at(-1)?.id ?? "root";
  if (!activeWatchScopes(state).has(scope)) fail(`Native watch frame scope ${scope} is not active.`);
  return scope;
}
function watchDetails(state, details) {
  const id = typeof details?.id === "string" && details.id.trim() ? details.id.trim() : "";
  if (!id) return null;
  const instanceId = typeof details?.instanceId === "string" && details.instanceId.trim() ? details.instanceId.trim() : null;
  const existing = state.watches[id];
  if (existing && instanceId && existing.instanceId && existing.instanceId !== instanceId) {
    fail(`Native watch identity for ${id} conflicts with the active arm; reconcile the native watch before mutating context.`);
  }
  return {
    owner: existing?.owner ?? watchOwner(state, details),
    ...(instanceId ? { instanceId } : {}),
    ...(typeof details.kind === "string" ? { kind: details.kind } : {}),
    ...(typeof details.target === "string" ? { target: details.target } : {}),
    ...(typeof details.prompt === "string" ? { prompt: details.prompt } : {}),
    ...(typeof details.repeatMs === "number" ? { repeatMs: details.repeatMs, repeat: true } : {}),
  };
}
function updateWatches(state, boundary) {
  const watches = structuredClone(state.watches);
  for (const result of boundary.toolResults ?? []) {
    if (result.isError) continue;
    const details = result.details;
    if (result.toolName === "watch" && details && ["armed", "already-armed"].includes(details.status)) {
      const id = typeof details.id === "string" ? details.id : "";
      const watch = watchDetails({ ...state, watches }, details);
      if (watch && id) watches[id] = watch;
    }
    if (result.toolName === "unwatch") {
      const instanceIds = Array.isArray(details?.cancelledInstanceIds)
        ? details.cancelledInstanceIds.filter((id) => typeof id === "string")
        : [];
      if (instanceIds.length) {
        for (const [id, watch] of Object.entries(watches)) if (instanceIds.includes(watch.instanceId)) delete watches[id];
      } else {
        for (const id of Array.isArray(details?.cancelledIds) ? details.cancelledIds : []) if (typeof id === "string") delete watches[id];
      }
    }
  }
  return watches;
}
function planWatchTransfer({ next, operation }) {
  const ids = operation.watchIds ?? operation.ids;
  ensureIds(ids, "watch IDs");
  if (!ids.length) fail("Select one or more native watch IDs to transfer.");
  const scope = operation.watchScope ?? operation.scope;
  if (typeof scope !== "string" || !activeWatchScopes(next).has(scope)) fail(`Watch transfer scope ${scope || ""} is not active.`);
  const current = next.frames.at(-1)?.id ?? "root";
  for (const id of ids) {
    const watch = next.watches[id];
    if (!watch) fail(`Unknown or finished native watch ${id}.`);
    if (watch.owner !== current) fail(`Native watch ${id} is owned by ${watch.owner}; only its owner may transfer it.`);
  }
  for (const id of ids) next.watches[id].owner = scope;
  return ids;
}
export function planWatchBoundary({ state: input, boundary }) {
  const state = normalizeContextState(input);
  const watches = updateWatches(state, boundary);
  if (JSON.stringify(watches) === JSON.stringify(state.watches)) return null;
  const next = { ...state, watches, revision: state.revision + 1 };
  return { state: next, entries: [contextStateEntry(next)], continue: false };
}
export function releaseWatchMessages(input, text) {
  const state = normalizeContextState(input);
  if (typeof text !== "string" || !/^WATCH_(?:SETTLED|LOST):/.test(text)) return null;
  // Native pi-await explicitly says a repeating round remains armed. Only a
  // terminal wake or LOST notice releases ownership; no observer is needed.
  if (/^repeat:\s*round \d+ settled(?:, round \d+ armed| and the watch is still armed)(?: \(every \d+ms\))?$/m.test(text)) return null;
  const ids = [...text.matchAll(/(?:^|\n)id:\s*([^\s\n]+)/g)].map((match) => match[1]);
  if (ids.length === 0 && text.startsWith("WATCH_LOST:")) {
    ids.push(...[...text.matchAll(/^\s{2}(\S+)\s+\[[^\]]+\]/gm)].map((match) => match[1]));
  }
  const watches = { ...state.watches };
  let changed = false;
  for (const id of ids) {
    const watch = watches[id];
    if (!watch) continue;
    const kind = /^kind:\s*(.+)$/m.exec(text)?.[1];
    const target = /^target:\s*(.*)$/m.exec(text)?.[1];
    if (watch.kind && kind && watch.kind !== kind) continue;
    if (watch.target && target && watch.target !== target) continue;
    delete watches[id];
    changed = true;
  }
  if (!changed) return null;
  const next = { ...state, watches, revision: state.revision + 1 };
  return { state: next, entry: contextStateEntry(next) };
}

/**
 * Build a request-only overlay for pins omitted by native compaction. The overlay
 * is derived from the committed state and raw branch, never persisted as a second
 * transcript. It is intentionally a custom/user-context message so text and image
 * blocks use Pi's normal provider conversion without granting source data system authority.
 */
export function pinnedContextOverlay(branch, state, messages = [], goalVersion) {
  const normalized = retentionForGoal(state, goalVersion);
  if (!normalized.pins.length) return [];
  const index = { byId: new Map(branch.map((entry) => [entry.id, entry])) };
  const present = new Set(messages.filter((message) => message.role !== "system" && message.content !== undefined).map((message) => contentVersion(message.content)));
  const seen = new Set();
  const overlays = [];
  for (const pin of normalized.pins) {
    if (seen.has(pin.key)) continue;
    seen.add(pin.key);
    const head = normalized.values[pin.key];
    const value = { id: pin.id, key: pin.key, head, content: valueContent(index, head) };
    const rendered = renderValue(value);
    // Exact envelope equality only proves that the outgoing data is present.
    // Never use content equality to attribute, edit or delete another message.
    if (present.has(contentVersion(rendered))) continue;
    if (messages.some((message) => isValueMessage(message, pin.key, head.version))) fail(`Retained pin ${pin.id} was altered in the outgoing context.`);
    const draft = valueMessage(value);
    overlays.push({ role: "custom", customType: draft.customType, content: draft.content, display: draft.display, details: draft.details, timestamp: 0 });
  }
  return overlays;
}

export function retentionForGoal(input, goalVersion) {
  const next = normalizeContextState(input);
  if (Number.isSafeInteger(goalVersion)) next.pins = next.pins.filter((pin) => pin.goalVersion === undefined || pin.goalVersion === goalVersion);
  return next;
}

/** Keep genuine structured answers by immutable source reference, not by copying a child exchange. */
export function planObservationBoundary({ state: input, branch, boundary, goalVersion = 1 }) {
  const next = normalizeContextState(input);
  const expired = next.pins.filter((pin) => pin.goalVersion !== undefined && pin.goalVersion !== goalVersion);
  if (!expired.length && !(boundary.toolResults ?? []).some((result) => /ask.*user.*question|ask_user_question/i.test(result.toolName))) return null;
  const index = sourceIndex(branch, boundary);
  const entries = [];
  next.pins = next.pins.filter((pin) => !expired.includes(pin));
  for (const key of new Set(expired.map((pin) => pin.key))) {
    if (next.pins.some((pin) => pin.key === key)) continue;
    const id = key.slice(key.indexOf("/") + 1);
    const value = currentValue(next, index, id, { key, allowHidden: true });
    const head = next.values[key];
    head.handling = "retired";
    head.handlingReason = "The owning Goal version ended.";
    if (value.message) entries.push(...writeView(next, value, head, value.content));
  }
  for (const id of boundary.toolResultEntryIds ?? []) {
    const entry = index.byId.get(id);
    const content = questionnaireContent(entry);
    const key = `root/${id}`;
    if (!content || next.values[key]) continue;
    const pointer = [{ type: "text", text: `Historical Human answer ${id} is retained as structured data below; this pointer is not a new decision.` }];
    const head = {
      entryId: id, field: "questionnaire", version: contentVersion(content), kind: "human", readOnly: true, rendered: true,
      handling: "active", caveats: [], sources: [id], pointerVersion: contentVersion(pointer),
    };
    next.values[key] = head;
    next.pins.push({ id, key, scope: "root", goalVersion });
    entries.push(nativeEdit(id, pointer), valueMessage({ id, key, head, content }));
  }
  if (!entries.length && !expired.length) return null;
  next.revision += 1;
  entries.push(nativeMessage(`Context observations retained; revision ${next.revision}. Human handling remains explicit.`, { action: "observation", revision: next.revision }));
  return { state: next, entries: transitionEntries(next, branch, boundary, { id: `${branch.at(-1)?.id ?? "root"}:observation` }, entries) };
}

/** Materialize the same qualified snapshots at an existing native boundary, without another request. */
export function planRetentionBoundary({ state: input, branch, boundary }) {
  const next = normalizeContextState(input);
  const overlays = pinnedContextOverlay(branch, next, boundary.context.contextMessages);
  if (!overlays.length) return null;
  const entries = overlays.map(({ role: _role, timestamp: _timestamp, ...message }) => ({ type: "custom_message", ...message }));
  next.revision += 1;
  entries.push(nativeMessage(`Context retention applied; revision ${next.revision}. Sources: ${overlays.map((message) => message.details.sourceId).join(", ")}.`, { action: "retention", revision: next.revision }));
  const operation = { id: `${branch.at(-1)?.id ?? "root"}:retention` };
  return { state: next, entries: transitionEntries(next, branch, boundary, operation, entries), continue: false };
}

/** On-demand lexical recovery; no cross-session store or sibling-branch traversal. */
export function searchContext(branch, boundary, state, options = {}) {
  const index = sourceIndex(branch, boundary);
  const scope = options.sourceScope ?? options.scope ?? "active";
  const result = searchSources(index, state, { ...options, scope });
  const repetition = options.compare === undefined ? undefined : analyzeRepeatedSelections(index, state, options.compare, scope);
  const ranked = options.rankedSources === undefined ? undefined : rankVerifiedSources(index, state, options.rankedSources, scope);
  return {
    revision: state.revision, frame: state.frames.at(-1)?.id ?? "root", ...result,
    ...(repetition ? { repetition } : {}),
    ...(ranked ? { ranked } : {}),
    hits: result.hits.map((hit) => ({ ...hit, sources: hit.provenance, kind: state.values[hit.binding]?.kind ?? hit.kind ?? (hit.role === "user" ? "human" : "working"), pinned: state.pins.some((pin) => pin.key === hit.binding) })),
  };
}
