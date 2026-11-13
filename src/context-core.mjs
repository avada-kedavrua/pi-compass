import { createHash } from "node:crypto";

export const CONTEXT_STATE_TYPE = "pi-compass-v2.context";
export const CONTEXT_MESSAGE_TYPE = "pi-compass-v2.context-message";
export const CONTEXT_SCHEMA_VERSION = 2;
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
function textOf(content) {
  return typeof content === "string" ? content : (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function messageOf(entry) {
  if (entry?.type === "message") return entry.message;
  if (entry?.type === "custom_message") return { role: "custom", customType: entry.customType, content: entry.content };
  return null;
}
function editable(entry) {
  const message = messageOf(entry);
  return Boolean(message && ["user", "assistant", "toolResult", "custom"].includes(message.role) && !RESERVED_MESSAGES.has(message.customType));
}
export function contentVersion(content) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 24);
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

export function emptyContextState() {
  return { schemaVersion: CONTEXT_SCHEMA_VERSION, revision: 0, frames: [], pins: [], writes: {}, watches: {} };
}

/** Validate current control metadata. Unsupported/corrupt state is never silently reset. */
export function normalizeContextState(raw) {
  if (raw === undefined || raw === null) return emptyContextState();
  if (!object(raw) || raw.schemaVersion !== CONTEXT_SCHEMA_VERSION) fail("Unsupported Compass context schema; open a new session or navigate to a pre-context branch.");
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.frames) || raw.frames.length > MAX_DEPTH || !Array.isArray(raw.pins) || raw.pins.length > MAX_PINS || !object(raw.writes) || !object(raw.watches)) fail("Invalid Compass context metadata.");
  const scopes = new Set(["root"]);
  let parent = "root";
  for (const frame of raw.frames) {
    if (!object(frame) || typeof frame.id !== "string" || !frame.id || scopes.has(frame.id) || frame.parent !== parent || typeof frame.boundaryId !== "string" || !(frame.summaryId === null || typeof frame.summaryId === "string")) fail("Invalid frame stack or parent summary reference.");
    if (!Array.isArray(frame.saved) || !Array.isArray(frame.refs)) fail("Invalid frame source lists.");
    ensureIds(frame.saved.map((item) => item.id), "saved source IDs");
    ensureIds(frame.refs.map((item) => item.id), "reference capture IDs");
    for (const item of frame.saved) if (typeof item.visible !== "boolean" || !(item.editId === null || typeof item.editId === "string")) fail("Invalid saved source reference.");
    for (const item of frame.refs) ensureVersion(item.version);
    scopes.add(frame.id);
    parent = frame.id;
  }
  for (const pin of raw.pins) if (!object(pin) || typeof pin.id !== "string" || !scopes.has(pin.scope)) fail("Invalid pin owner.");
  for (const version of Object.values(raw.writes)) ensureVersion(version);
  for (const watch of Object.values(raw.watches)) if (!object(watch) || !scopes.has(watch.owner)) fail("Invalid watch owner.");
  return structuredClone({ schemaVersion: raw.schemaVersion, revision: raw.revision, frames: raw.frames, pins: raw.pins, writes: raw.writes, watches: raw.watches });
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
  const editsByTarget = new Map();
  const groups = new Map();
  const calls = new Map();
  for (const [position, entry] of branch.entries()) {
    byId.set(entry.id, entry);
    positions.set(entry.id, position);
    if (entry.type === "context_edit") {
      const rows = editsByTarget.get(entry.targetId) ?? [];
      rows.push(entry);
      editsByTarget.set(entry.targetId, rows);
    }
    const message = messageOf(entry);
    if (message?.role === "assistant") {
      const toolCalls = message.content.filter((part) => part.type === "toolCall");
      if (!toolCalls.length) continue;
      const group = { ids: [entry.id], calls: new Set(toolCalls.map((call) => call.id)), results: new Set(), duplicate: false };
      groups.set(entry.id, group);
      for (const call of toolCalls) calls.set(call.id, group);
    }
    if (message?.role === "toolResult") {
      const group = calls.get(message.toolCallId);
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
  return { branch, byId, positions, editsByTarget, groups, active, edits };
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
function projectedContent(entry, content) {
  const role = messageOf(entry).role;
  return typeof content === "string" && ["assistant", "toolResult"].includes(role) ? [{ type: "text", text: content }] : content;
}
function versionContent(index, id, version) {
  const entry = source(index, id);
  const original = messageOf(entry).content;
  if (contentVersion(original) === version) return original;
  const rows = index.editsByTarget.get(id) ?? [];
  for (let position = rows.length - 1; position >= 0; position--) {
    const content = rows[position].replacement?.content;
    if (content !== undefined) {
      const projected = projectedContent(entry, content);
      if (contentVersion(projected) === version) return projected;
    }
  }
  fail(`Version ${version} of source ${id} is unavailable.`);
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
function snapshot(index, turnIds) {
  const saved = [];
  for (const [id, item] of index.active) {
    if (turnIds.has(id)) continue;
    const message = item.messages[0];
    saved.push({ id, editId: index.edits.get(id)?.id ?? null, visible: Boolean(message) });
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
  for (const item of captures) {
    if (!["ref", "copy"].includes(item.mode)) fail("Capture mode must be ref or copy.");
    const content = visible(index, item.id).content;
    if (contentVersion(content) !== item.version) fail(`Stale capture ${item.id}.`);
    if (item.mode === "ref") refs.push({ id: item.id, version: item.version });
    else { ensureContent(content); copies.push({ ...item, content }); }
  }
  const saved = snapshot(index, turnIds);
  const summary = latestSummary(boundary);
  const frame = { id: operation.id, parent: next.frames.at(-1)?.id ?? "root", boundaryId: boundary.messageEntryId, saved, refs, summaryId: summary?.id ?? null };
  const kept = exchangeClosure(index, [...refs.map((item) => item.id), ...next.pins.map((pin) => pin.id)]);
  for (const id of kept) visible(index, id);
  next.frames.push(frame);
  const entries = summary ? [nativeCheckpoint("", saved[0]?.id ?? null, operation.id)] : [];
  for (const [id, item] of index.active) if (item.messages.length && (turnIds.has(id) || !kept.has(id))) entries.push(nativeEdit(id, null));
  for (const copy of copies) entries.push(nativeMessage(copy.content, { frame: frame.id, mode: "copy", source: copy.id, version: copy.version }));
  entries.push(nativeMessage(`Frame ${frame.id}; context revision ${next.revision + 1}.\nTask: ${operation.task}\nExplicit ref sources: ${refs.map((ref) => ref.id).join(", ") || "none"}. Return explicitly with compass_context; exports default to none. Environment effects remain.`, { frame: frame.id, action: "call" }));
  return entries;
}
function external(entry) {
  const message = messageOf(entry);
  return message?.role === "user" || (message?.role === "custom" && EXTERNAL_MESSAGES.has(message.customType));
}
function planReturn({ next, index, boundary, operation }) {
  const frame = next.frames.at(-1);
  if (!frame) fail("No active context frame.");
  const watches = Object.keys(next.watches).filter((id) => next.watches[id].owner === frame.id);
  if (watches.length) fail(`Frame owns active watches: ${watches.join(", ")}. Cancel or transfer them before returning.`);
  ensureIds(operation.exportIds ?? [], "export IDs");
  const boundaryPosition = index.positions.get(frame.boundaryId);
  if (boundaryPosition === undefined) fail("Frame boundary is not on the active branch.");
  const savedIds = new Set(frame.saved.map((item) => item.id));
  const references = new Map(frame.refs.map((ref) => [ref.id, ref.version]));
  const owned = index.branch.slice(boundaryPosition).filter(editable);
  const summary = frame.summaryId === null ? null : index.byId.get(frame.summaryId);
  if (frame.summaryId !== null && summary?.type !== "compaction") fail("Parent summary is unavailable on this branch.");
  const firstKeptEntryId = frame.saved[0]?.id ?? summary?.id ?? owned.find(external)?.id ?? null;
  const entries = latestSummary(boundary)?.id !== frame.summaryId
    ? [nativeCheckpoint(summary?.summary ?? "", firstKeptEntryId, operation.id)] : [];
  // Iterate raw owned entries, not just the currently visible tail: compaction can hide local process.
  for (const entry of owned) if (!savedIds.has(entry.id) && !external(entry)) entries.push(nativeEdit(entry.id, null));
  for (const saved of frame.saved) {
    const version = next.writes[saved.id] ?? references.get(saved.id);
    const content = version ? versionContent(index, saved.id, version) : saved.visible ? historicalContent(index, saved.id, saved.editId) : null;
    entries.push(nativeEdit(saved.id, content));
  }
  for (const id of operation.exportIds ?? []) {
    const content = visible(index, id).content;
    ensureContent(content);
    entries.push(nativeMessage(content, { frame: frame.id, action: "export", source: id }));
  }
  if (operation.result !== undefined && operation.result !== "") {
    ensureText(operation.result, "Return value");
    entries.push(nativeMessage(`Return from ${frame.id}:\n${operation.result}`, { frame: frame.id, action: "result" }));
  }
  next.frames.pop();
  next.pins = next.pins.filter((pin) => pin.scope !== frame.id);
  const remainingRefs = new Set(next.frames.flatMap((item) => item.refs.map((ref) => ref.id)));
  next.writes = Object.fromEntries(Object.entries(next.writes).filter(([id]) => remainingRefs.has(id)));
  entries.push(nativeMessage(`Returned from ${frame.id}; context revision ${next.revision + 1}. Local process released; environment effects remain.`, { frame: frame.id, action: "return" }));
  return entries;
}
function planPins({ next, index, operation }) {
  ensureIds(operation.ids);
  if (!operation.ids.length) fail("Select sources to pin or unpin.");
  const scope = next.frames.at(-1)?.id ?? "root";
  for (const id of exchangeClosure(index, operation.ids)) {
    if (operation.action === "pin") {
      visible(index, id);
      if (!next.pins.some((pin) => pin.id === id && pin.scope === scope)) next.pins.push({ id, scope });
    } else next.pins = next.pins.filter((pin) => pin.id !== id || pin.scope !== scope);
  }
  if (next.pins.length > MAX_PINS) fail("At most 64 sources may be pinned.");
  return [];
}
function planEdits({ next, index, operation }) {
  ensureIds(operation.ids);
  if (!operation.ids.length) fail("Select sources to edit.");
  const ids = operation.action === "drop" ? exchangeClosure(index, operation.ids) : new Set(operation.ids);
  if (operation.action === "replace" && ids.size !== 1) fail("Replacement requires exactly one source.");
  const versions = new Map((operation.versions ?? []).map((item) => [item.id, item.version]));
  const refs = new Set(next.frames.flatMap((frame) => frame.refs.map((ref) => ref.id)));
  const entries = [];
  for (const id of ids) {
    const message = visible(index, id);
    if (next.pins.some((pin) => pin.id === id)) fail(`Pinned source ${id} must be explicitly unpinned first.`);
    if (message.role === "user") fail("Human messages cannot be replaced or dropped.");
    if (operation.action === "replace" && message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) fail("Assistant tool calls cannot be replaced; this would fabricate or orphan an execution.");
    if (operation.action === "drop" && refs.has(id)) fail(`Referenced outer slot ${id} cannot be dropped.`);
    const expected = operation.action === "replace" ? operation.version : versions.get(id);
    ensureVersion(expected);
    if (contentVersion(message.content) !== expected) fail(`Source ${id} changed since selection.`);
    let content = null;
    if (operation.action === "replace") {
      ensureText(operation.content, "Replacement");
      content = ["assistant", "toolResult"].includes(message.role) ? [{ type: "text", text: operation.content }] : operation.content;
      ensureContent(content);
    }
    entries.push(nativeEdit(id, content));
    if (refs.has(id)) next.writes[id] = contentVersion(content);
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
  let entries;
  switch (operation.action) {
    case "call": entries = planCall(args); break;
    case "return": entries = planReturn(args); break;
    case "pin": case "unpin": entries = planPins(args); break;
    case "replace": case "drop": entries = planEdits(args); break;
    default: fail(`Unknown context action ${operation.action}.`);
  }
  next.revision += 1;
  if (!["call", "return"].includes(operation.action)) entries.push(nativeMessage(`Context ${operation.action} applied; revision ${next.revision}. Sources: ${(operation.ids ?? []).join(", ")}.`, { action: operation.action, revision: next.revision }));
  return { state: next, entries: transitionEntries(next, branch, boundary, operation, entries), continue: ["call", "return"].includes(operation.action) && boundary.outcome === "completed" };
}

function updateWatches(state, boundary) {
  const watches = structuredClone(state.watches);
  for (const result of boundary.toolResults ?? []) {
    if (result.isError) continue;
    const details = result.details;
    if (result.toolName === "watch" && details?.id && ["armed", "already-armed"].includes(details.status) && !watches[details.id]) watches[details.id] = { owner: state.frames.at(-1)?.id ?? "root" };
    if (result.toolName === "unwatch") for (const id of details?.cancelledIds ?? []) delete watches[id];
  }
  return watches;
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
  if (/^repeat: round .*?(?:armed|still armed)/m.test(text)) return null;
  const ids = [...text.matchAll(/(?:^|\n)id:\s*(w\d+)\b/g)].map((match) => match[1]);
  const watches = { ...state.watches };
  let changed = false;
  for (const id of ids) if (watches[id]) { delete watches[id]; changed = true; }
  if (!changed) return null;
  const next = { ...state, watches, revision: state.revision + 1 };
  return { state: next, entry: contextStateEntry(next) };
}

/** Search remains lexical until M3 adds explicit historical loading and semantic ranking. */
export function searchContext(_branch, boundary, state, { query = "", ids = [], limit = 8 } = {}) {
  ensureIds(ids);
  if (typeof query !== "string" || query.length > 400 || !Number.isInteger(limit) || limit < 1 || limit > 16) fail("Search requires query <=400 characters and limit 1..16.");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const selected = new Set(ids);
  const hits = [];
  for (const item of [...boundary.context.contextEntries].reverse()) {
    if (!editable(item.sourceEntry) || !item.messages.length || (selected.size && !selected.has(item.sourceEntry.id))) continue;
    const message = item.messages[0];
    const text = textOf(message.content);
    const lower = text.toLowerCase();
    if (!terms.every((term) => lower.includes(term))) continue;
    const start = terms.length ? Math.max(0, lower.indexOf(terms[0]) - 80) : 0;
    hits.push({ id: item.sourceEntry.id, role: message.role, version: contentVersion(message.content), chars: text.length, pinned: state.pins.some((pin) => pin.id === item.sourceEntry.id), excerpt: text.slice(start, start + 600) });
    if (hits.length === limit) break;
  }
  return { revision: state.revision, frame: state.frames.at(-1)?.id ?? "root", hits };
}
