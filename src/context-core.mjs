import { createHash } from "node:crypto";

export const CONTEXT_STATE_TYPE = "pi-compass-v2.context";
export const CONTEXT_MESSAGE_TYPE = "pi-compass-v2.context-message";
export const CONTEXT_SCHEMA_VERSION = 1;

const MAX_DEPTH = 16;
const MAX_SOURCES = 256;
const MAX_PINS = 64;
const MAX_TEXT = 8_000;
const MAX_COPY_BYTES = 128 * 1024;
const MODEL_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);
const RESERVED_CUSTOM_TYPES = new Set([
  "pi-compass-v2.goalrun-state",
  "pi-compass-v2.goalrun-anchor",
  "pi-compass-v2.conventions",
]);

function fail(message) { throw new Error(`${message} No context changed.`); }
function isObject(value) { return value !== null && typeof value === "object"; }
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}
function messageOf(entry) {
  if (entry?.type === "message") return entry.message;
  if (entry?.type === "custom_message") {
    return { role: "custom", content: entry.content, customType: entry.customType, details: entry.details };
  }
  return null;
}
function isModelEntry(entry) {
  return MODEL_ROLES.has(messageOf(entry)?.role);
}
function isReserved(entry) {
  const message = messageOf(entry);
  return message?.role === "custom" && RESERVED_CUSTOM_TYPES.has(message.customType);
}
function isEditable(entry) {
  return isModelEntry(entry) && !isReserved(entry);
}
export function contentVersion(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
const hash = contentVersion;
function clone(value) { return structuredClone(value); }
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value)); }
function ensureText(value, label, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(`${label} must be a non-empty string of at most ${max} characters.`);
  return value;
}
function ensureIds(ids, label = "source IDs") {
  if (!Array.isArray(ids) || ids.length > MAX_SOURCES || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !id.trim())) {
    fail(`${label} must contain unique non-empty source IDs (at most ${MAX_SOURCES}).`);
  }
  return ids;
}
function ensureVersion(version) {
  if (typeof version !== "string" || !/^[a-f0-9]{24}$/.test(version)) fail("A current source version is required.");
}
export function emptyContextState() {
  return { schemaVersion: CONTEXT_SCHEMA_VERSION, revision: 0, frames: [], pins: [], writes: {}, watches: {} };
}

export function normalizeContextState(raw) {
  if (!isObject(raw) || raw.schemaVersion !== CONTEXT_SCHEMA_VERSION) return emptyContextState();
  const state = emptyContextState();
  state.revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  state.frames = Array.isArray(raw.frames) ? raw.frames.slice(-MAX_DEPTH).filter((frame) => isObject(frame) && typeof frame.id === "string" && typeof frame.parent === "string").map((frame) => ({
    id: frame.id,
    parent: frame.parent,
    boundaryId: typeof frame.boundaryId === "string" ? frame.boundaryId : "",
    saved: Array.isArray(frame.saved) ? frame.saved.slice(0, MAX_SOURCES).filter((item) => isObject(item) && typeof item.id === "string" && (item.editId === null || typeof item.editId === "string") && typeof item.version === "string" && typeof item.visible === "boolean").map((item) => ({ ...item })) : [],
    refs: Array.isArray(frame.refs) ? frame.refs.slice(0, MAX_SOURCES).filter((item) => isObject(item) && typeof item.id === "string" && typeof item.version === "string").map((item) => ({ id: item.id, version: item.version })) : [],
  })) : [];
  state.pins = Array.isArray(raw.pins) ? raw.pins.slice(-MAX_PINS).filter((pin) => isObject(pin) && typeof pin.id === "string" && typeof pin.scope === "string").map((pin) => ({ id: pin.id, scope: pin.scope })) : [];
  state.writes = isObject(raw.writes) ? Object.fromEntries(Object.entries(raw.writes).filter(([id, version]) => typeof id === "string" && typeof version === "string")) : {};
  state.watches = isObject(raw.watches) ? Object.fromEntries(Object.entries(raw.watches).filter(([id, watch]) => typeof id === "string" && isObject(watch) && typeof watch.owner === "string").map(([id, watch]) => [id, { owner: watch.owner }])) : {};
  const active = new Set(state.frames.map((frame) => frame.id));
  state.pins = state.pins.filter((pin) => pin.scope === "root" || active.has(pin.scope));
  state.writes = Object.fromEntries(Object.entries(state.writes).filter(([id]) => state.frames.some((frame) => frame.refs.some((ref) => ref.id === id))));
  state.watches = Object.fromEntries(Object.entries(state.watches).filter(([, watch]) => active.has(watch.owner)));
  return state;
}

export function restoreContextState(branch) {
  let restored = emptyContextState();
  for (const entry of branch ?? []) {
    if (entry?.type !== "custom" || entry.customType !== CONTEXT_STATE_TYPE) continue;
    restored = normalizeContextState(entry.data);
  }
  return restored;
}

export function contextStateEntry(state) {
  return { type: "custom", customType: CONTEXT_STATE_TYPE, data: clone(normalizeContextState(state)) };
}

function branchIndex(branch) {
  const byId = new Map((branch ?? []).map((entry) => [entry.id, entry]));
  const edits = new Map();
  for (const entry of branch ?? []) if (entry?.type === "context_edit") edits.set(entry.targetId, entry);
  return { byId, edits };
}

function currentSource(branch, id) {
  const { byId } = branchIndex(branch);
  const source = byId.get(id);
  if (!source || !isEditable(source)) fail(`Unknown, wrong-branch, reserved, or non-editable context source ${id}.`);
  return source;
}

function contentAt(branch, id, editId = undefined) {
  const { byId, edits } = branchIndex(branch);
  const source = currentSource(branch, id);
  const selected = editId === undefined ? edits.get(id) : editId === null ? null : byId.get(editId);
  if (editId !== undefined && editId !== null && (!selected || selected.type !== "context_edit" || selected.targetId !== id)) fail(`Stale context edit ${editId} for ${id}.`);
  if (selected?.replacement === null) return null;
  return clone(selected?.replacement?.content ?? messageOf(source).content);
}

function editIdAt(branch, id) {
  return branchIndex(branch).edits.get(id)?.id ?? null;
}

function sourceById(boundary) {
  const result = new Map();
  for (const item of boundary?.context?.contextEntries ?? []) {
    if (item?.sourceEntry?.id && isEditable(item.sourceEntry)) result.set(item.sourceEntry.id, item);
  }
  return result;
}

function contentFromBoundary(item) {
  const message = item?.messages?.[0];
  return message?.content;
}

function savedSnapshot(branch, boundary, excludedIds) {
  const sources = sourceById(boundary);
  const saved = [];
  for (const [id, item] of sources) {
    if (excludedIds.has(id)) continue;
    const content = contentFromBoundary(item);
    if (content === undefined) continue;
    saved.push({ id, editId: editIdAt(branch, id), version: hash(content), visible: item.messages.length > 0 });
  }
  return saved;
}

function firstKeptId(branch, saved) {
  const { byId } = branchIndex(branch);
  return saved.map((item) => byId.get(item.id)).find((entry) => entry?.type === "message" || entry?.type === "custom_message")?.id ?? null;
}

function nativeEdit(targetId, content) {
  return { type: "context_edit", targetId, replacement: content === null ? null : { content: clone(content) } };
}
function nativeMessage(content, details = {}) {
  return { type: "custom_message", customType: CONTEXT_MESSAGE_TYPE, content, display: false, details };
}
function internalNote(text, details = {}) { return nativeMessage(text, details); }
function compactSummary(text, firstKeptEntryId, details) {
  return { type: "compaction", summary: text, firstKeptEntryId, details };
}
function checkContent(content, label) {
  if (content === undefined || content === null || byteLength(content) > MAX_COPY_BYTES) fail(`${label} exceeds the 128 KiB context bound.`);
}
function pinnedIds(state) {
  return new Set(state.pins.map((pin) => pin.id));
}
function ancestorPinnedIds(state) {
  const scopes = new Set(["root", ...state.frames.map((frame) => frame.id)]);
  return new Set(state.pins.filter((pin) => scopes.has(pin.scope)).map((pin) => pin.id));
}
function modelRoleForId(branch, id) { return messageOf(currentSource(branch, id))?.role; }

function toolExchangeIds(branch, selectedIds) {
  const calls = new Map();
  const results = new Map();
  const sourceIds = new Set(selectedIds);
  for (const entry of branch) {
    const message = messageOf(entry);
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) if (part?.type === "toolCall" && typeof part.id === "string") calls.set(part.id, entry.id);
    }
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") results.set(message.toolCallId, entry.id);
  }
  for (const id of selectedIds) {
    const role = modelRoleForId(branch, id);
    if (role === "assistant") {
      const message = messageOf(currentSource(branch, id));
      const callIds = (message.content ?? []).filter((part) => part?.type === "toolCall").map((part) => part.id);
      if (!callIds.length) continue;
      const missing = callIds.filter((callId) => !results.has(callId));
      if (missing.length) fail(`Tool exchange ${id} is incomplete; it cannot be dropped.`);
      sourceIds.add(...callIds.map((callId) => results.get(callId)));
    } else if (role === "toolResult") {
      const message = messageOf(currentSource(branch, id));
      const assistantId = calls.get(message.toolCallId);
      if (!assistantId) fail(`Tool result ${id} has no matching assistant tool call.`);
      sourceIds.add(assistantId);
    }
  }
  return sourceIds;
}

function activeWatchIds(state, owner) {
  return Object.entries(state.watches).filter(([, watch]) => watch.owner === owner).map(([id]) => id);
}

function operationFromBoundary(boundary, toolName) {
  if (!boundary || boundary.message?.role !== "assistant" || !Array.isArray(boundary.message.content)) return null;
  const calls = boundary.message.content.filter((part) => part?.type === "toolCall" && part.name === toolName);
  if (calls.length !== 1 || boundary.toolResults?.length !== 1) return null;
  const call = calls[0];
  const result = boundary.toolResults[0];
  if (result.toolCallId !== call.id || result.isError || !isObject(result.details?.contextOperation)) return null;
  return { ...result.details.contextOperation, callId: call.id };
}

function updateWatches(state, boundary) {
  const next = clone(state.watches);
  for (const result of boundary.toolResults ?? []) {
    if (!result?.toolName) continue;
    const parsed = (() => {
      try { return JSON.parse((result.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n")); } catch { return null; }
    })();
    const details = isObject(result.details) ? result.details : parsed;
    if (result.toolName === "watch" && details?.id && ["armed", "already-armed"].includes(details.status)) {
      const owner = state.frames.at(-1)?.id ?? "root";
      if (!next[details.id]) next[details.id] = { owner };
    }
    if (result.toolName === "unwatch" && Array.isArray(details?.cancelledIds)) {
      for (const id of details.cancelledIds) delete next[id];
    }
  }
  return next;
}

/** Bounded on-demand lookup. Hits are references; they do not authorize edits. */
export function planWatchBoundary({ state: input, boundary }) {
  const state = normalizeContextState(input);
  const watches = updateWatches(state, boundary);
  if (JSON.stringify(watches) === JSON.stringify(state.watches)) return null;
  const next = { ...state, watches, revision: state.revision + 1 };
  return { state: next, entries: [contextStateEntry(next)], continue: false };
}

export function releaseWatchMessages(input, text) {
  const state = normalizeContextState(input);
  if (typeof text !== "string" || !text.includes("WATCH_")) return null;
  const ids = [...text.matchAll(/(?:^|\n)id:\s*(w\d+)\b/gim)].map((match) => match[1]);
  if (!ids.length) return null;
  const watches = { ...state.watches };
  let changed = false;
  for (const id of ids) if (watches[id]) { delete watches[id]; changed = true; }
  if (!changed) return null;
  const next = { ...state, watches, revision: state.revision + 1 };
  return { state: next, entry: contextStateEntry(next) };
}

export function searchContext(branch, boundary, state, { query = "", ids = [], limit = 8 } = {}) {
  ensureIds(ids);
  if (typeof query !== "string" || query.length > 400) fail("Search query must be at most 400 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) fail("Search limit must be between 1 and 16.");
  const selected = new Set(ids);
  const hits = [];
  for (const item of [...(boundary?.context?.contextEntries ?? [])].reverse()) {
    const source = item.sourceEntry;
    if (!isEditable(source) || (selected.size && !selected.has(source.id)) || !item.messages.length) continue;
    const message = item.messages[0];
    const text = textContent(message.content);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length && !terms.every((term) => text.toLowerCase().includes(term))) continue;
    const start = terms.length ? Math.max(0, text.toLowerCase().indexOf(terms[0]) - 80) : 0;
    hits.push({ id: source.id, role: message.role, version: hash(message.content), chars: text.length, pinned: state.pins.some((pin) => pin.id === source.id), excerpt: text.slice(start, start + 600) });
    if (hits.length >= limit) break;
  }
  return { revision: state.revision, frame: state.frames.at(-1)?.id ?? "root", hits };
}

/** Plan entering a frame and keep only explicit references plus inherited pins. */
function planCall({ next, branch, boundary, operation, sourceMap, turnIds, inheritedPins }) {
  if (next.frames.length >= MAX_DEPTH) fail("Context frame depth limit (16) reached.");
  ensureText(operation.task, "Frame task", 4_000);
  const capture = Array.isArray(operation.capture) ? operation.capture : [];
  ensureIds(capture.map((item) => item?.id), "capture IDs");
  const refs = [];
  const copies = [];
  for (const item of capture) {
    if (!isObject(item) || !["ref", "copy"].includes(item.mode)) fail("Each capture must specify mode ref or copy.");
    const source = sourceMap.get(item.id);
    if (!source?.messages?.length) fail(`Capture ${item.id} is not visible in the current context.`);
    const content = contentFromBoundary(source);
    if (hash(content) !== item.version) fail(`Capture ${item.id} is stale; search again for its current version.`);
    if (item.mode === "ref") refs.push({ id: item.id, version: item.version });
    else { checkContent(content, `Copy ${item.id}`); copies.push({ id: item.id, content, version: item.version }); }
  }
  const saved = savedSnapshot(branch, boundary, turnIds);
  const frame = { id: operation.callId, parent: next.frames.at(-1)?.id ?? "root", boundaryId: boundary.messageEntryId, saved, refs };
  next.frames.push(frame);
  const keep = new Set([...refs.map((item) => item.id), ...inheritedPins]);
  const entries = [compactSummary(`Frame ${frame.id} entered. Parent context is suspended; only explicit references and pinned material remain.`, firstKeptId(branch, saved), { compassFrame: frame.id, action: "call" })];
  for (const [id, item] of sourceMap) {
    if (turnIds.has(id)) entries.push(nativeEdit(id, null));
    else if (!keep.has(id) && item.messages.length) entries.push(nativeEdit(id, null));
    else if (keep.has(id) && !item.messages.length) {
      const content = contentAt(branch, id);
      if (content === null) fail(`Pinned or referenced source ${id} is unavailable in the current projection.`);
      entries.push(nativeEdit(id, content));
    }
  }
  for (const copy of copies) entries.push(nativeMessage(copy.content, { frame: frame.id, mode: "copy", source: copy.id, version: copy.version }));
  entries.push(internalNote(`Frame ${frame.id}\nTask: ${operation.task}\nUse compass_context action=return to leave. Capture and export default to none. Environment changes are not rolled back.`, { frame: frame.id, action: "call" }));
  return entries;
}

/** Plan returning to the parent projection while retaining Human steering. */
function planReturn({ next, branch, operation, sourceMap }) {
  const frame = next.frames.at(-1);
  if (!frame) fail("No active context frame.");
  const ownedWatches = activeWatchIds(next, frame.id);
  if (ownedWatches.length) fail(`Frame owns active watches: ${ownedWatches.join(", ")}. Cancel or transfer them before returning.`);
  const exportIds = Array.isArray(operation.exportIds) ? operation.exportIds : [];
  ensureIds(exportIds, "export IDs");
  const savedIds = new Set(frame.saved.map((item) => item.id));
  const refs = new Set(frame.refs.map((item) => item.id));
  const userIdsAfterBoundary = new Set();
  const boundaryIndex = branch.findIndex((entry) => entry.id === frame.boundaryId);
  for (const entry of branch.slice(boundaryIndex + 1)) if (messageOf(entry)?.role === "user") userIdsAfterBoundary.add(entry.id);
  const preserve = new Set([...savedIds, ...userIdsAfterBoundary]);
  const entries = [compactSummary(`Returned from frame ${frame.id}. Local work is released; exported values and Human messages remain.`, firstKeptId(branch, frame.saved), { compassFrame: frame.id, action: "return" })];
  for (const [id, item] of sourceMap) {
    if (!preserve.has(id) && item.messages.length && messageOf(currentSource(branch, id))?.role !== "user") entries.push(nativeEdit(id, null));
  }
  for (const saved of frame.saved) if (!refs.has(saved.id)) entries.push(nativeEdit(saved.id, saved.visible ? contentAt(branch, saved.id, saved.editId) : null));
  for (const id of exportIds) {
    const item = sourceMap.get(id);
    if (!item?.messages?.length) fail(`Export ${id} is not visible in the current context.`);
    const content = contentFromBoundary(item);
    checkContent(content, `Export ${id}`);
    entries.push(nativeMessage(content, { frame: frame.id, action: "export", source: id }));
  }
  if (operation.result !== undefined) {
    ensureText(operation.result, "Frame result", 8_000);
    entries.push(internalNote(`Return from ${frame.id}:\n${operation.result}`, { frame: frame.id, action: "result" }));
  }
  entries.push(internalNote(`Frame ${frame.id} returned; local context released.`, { frame: frame.id, action: "return" }));
  next.frames.pop();
  next.pins = next.pins.filter((pin) => pin.scope !== frame.id);
  const activeRefs = new Set(next.frames.flatMap((item) => item.refs.map((ref) => ref.id)));
  next.writes = Object.fromEntries(Object.entries(next.writes).filter(([id]) => activeRefs.has(id)));
  return entries;
}

function planPins({ next, branch, operation, sourceMap, scope }) {
  const ids = ensureIds(operation.ids);
  if (!ids.length) fail("Select at least one source to pin or unpin.");
  for (const id of ids) {
    const item = sourceMap.get(id);
    if (!item) currentSource(branch, id);
    if (operation.action === "pin") {
      if (!item.messages.length) fail(`Cannot pin omitted source ${id}; load it first.`);
      if (!next.pins.some((pin) => pin.id === id && pin.scope === scope)) next.pins.push({ id, scope });
    } else next.pins = next.pins.filter((pin) => pin.id !== id || pin.scope !== scope);
  }
  if (next.pins.length > MAX_PINS) fail("At most 64 source references may be pinned.");
  return [];
}

function planEdits({ next, branch, operation, sourceMap, currentPins }) {
  const ids = ensureIds(operation.ids);
  if (!ids.length) fail("Select at least one source to replace or drop.");
  const expanded = operation.action === "drop" ? toolExchangeIds(branch, ids) : new Set(ids);
  if (operation.action === "replace" && expanded.size !== 1) fail("Replacement requires exactly one source.");
  const refIds = new Set(next.frames.flatMap((frame) => frame.refs.map((ref) => ref.id)));
  const expectedVersions = new Map(Array.isArray(operation.versions) ? operation.versions.map((item) => [item.id, item.version]) : []);
  const entries = [];
  for (const id of expanded) {
    const source = currentSource(branch, id);
    const item = sourceMap.get(id);
    if (!item?.messages?.length) fail(`Source ${id} is omitted; search/load it before editing.`);
    if (currentPins.has(id)) fail(`Pinned source ${id} must be explicitly unpinned first.`);
    const actualVersion = hash(contentFromBoundary(item));
    const role = messageOf(source)?.role;
    if (role === "user") fail("Human messages cannot be replaced or dropped.");
    if (operation.action === "drop" && refIds.has(id)) fail(`Referenced outer slot ${id} cannot be dropped; replace its value instead.`);
    const expectedVersion = operation.action === "replace" ? operation.version : expectedVersions.get(id);
    ensureVersion(expectedVersion);
    if (expectedVersion !== actualVersion) fail(`Source ${id} changed since it was selected; no edit applied.`);
    if (operation.action === "replace") ensureText(operation.content, "Replacement content");
    const content = operation.action === "drop" ? null : ["assistant", "toolResult"].includes(role) ? [{ type: "text", text: operation.content }] : operation.content;
    checkContent(content, `Replacement for ${id}`);
    entries.push(nativeEdit(id, content));
    if (refIds.has(id)) next.writes[id] = hash(content);
  }
  return entries;
}

/**
 * Convert one completed tool turn into append-only native boundary entries.
 * The returned state is metadata only; all message content remains in Pi's transcript.
 */
export function planContextBoundary({ state: input, branch, boundary, toolName = "compass_context", watchResult = true }) {
  const state = normalizeContextState(input);
  const operation = operationFromBoundary(boundary, toolName);
  if (!operation || operation.action === "search") return null;
  if (operation.expectedRevision !== state.revision) fail(`Stale context revision ${operation.expectedRevision}; current revision is ${state.revision}.`);
  const next = clone(state);
  const sourceMap = sourceById(boundary);
  const turnIds = new Set([boundary.messageEntryId, ...(boundary.toolResultEntryIds ?? [])]);
  const scope = next.frames.at(-1)?.id ?? "root";
  const entries = operation.action === "call"
    ? planCall({ next, branch, boundary, operation, sourceMap, turnIds, inheritedPins: ancestorPinnedIds(next) })
    : operation.action === "return"
      ? planReturn({ next, branch, operation, sourceMap })
      : ["pin", "unpin"].includes(operation.action)
        ? planPins({ next, branch, operation, sourceMap, scope })
        : ["replace", "drop"].includes(operation.action)
          ? planEdits({ next, branch, operation, sourceMap, currentPins: pinnedIds(next) })
          : fail(`Unknown context action ${operation.action}.`);
  if (watchResult) next.watches = updateWatches(next, boundary);
  next.revision += 1;
  next.writes = Object.fromEntries(Object.entries(next.writes).filter(([id]) => next.frames.some((frame) => frame.refs.some((ref) => ref.id === id))));
  entries.push(contextStateEntry(next));
  return { state: next, entries, continue: ["call", "return"].includes(operation.action) && boundary.outcome === "completed" };
}
