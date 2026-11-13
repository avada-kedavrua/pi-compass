import { bindingKey, contentVersion, logicalSource, rawMessage, valueContent } from "./context-values.mjs";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 32;
const MAX_SCAN = 256;

function fail(message) { throw new Error(`${message} No context changed.`); }
function textParts(content) {
  if (typeof content === "string") return [{ part: 0, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item, part) => item?.type === "text" && typeof item.text === "string" ? [{ part, text: item.text }] : []);
}
function savedValue(index, state, saved) {
  if (saved.binding) {
    const head = state.values[saved.binding];
    if (!head || contentVersion(head) !== saved.valueState) return null;
    try { return { content: valueContent(index, head), head, binding: saved.binding }; } catch { return null; }
  }
  if (saved.editId !== null) {
    const edit = index.byId.get(saved.editId);
    if (edit?.type !== "context_edit" || edit.targetId !== saved.id || edit.replacement === null) return null;
    const content = edit.replacement.content;
    return { content, head: null, binding: null };
  }
  const entry = index.byId.get(saved.id);
  const message = rawMessage(entry);
  return message && Object.hasOwn(message, "content") ? { content: message.content, head: null, binding: null } : null;
}
function activeValue(index, state, id) {
  const key = bindingKey(state, index, id);
  const head = state.values[key];
  if (head) return { content: valueContent(index, head), head, binding: key };
  const item = index.active.get(id);
  if (item?.messages?.length) return { content: item.messages[0].content, head: null, binding: key };
  const edit = index.edits.get(id);
  if (edit) return edit.replacement === null ? null : { content: edit.replacement.content, head: null, binding: key };
  const message = rawMessage(index.byId.get(id));
  return message && Object.hasOwn(message, "content") ? { content: message.content, head: null, binding: key } : null;
}
function makeRecord(index, state, id, origin, recovered) {
  const sourceId = logicalSource(index, id);
  const entry = index.byId.get(sourceId);
  if (!entry) return null;
  let value;
  if (recovered) value = savedValue(index, state, recovered);
  else value = activeValue(index, state, sourceId);
  if (!value) return null;
  const head = value.head;
  const version = head?.version ?? contentVersion(value.content);
  const message = rawMessage(entry);
  return {
    id: sourceId,
    binding: value.binding ?? (head ? null : bindingKey(state, index, sourceId)),
    version,
    content: value.content,
    caveats: [...(head?.caveats ?? (message?.isError ? ["Original tool execution failed; content is not evidence of a successful rerun."] : []))],
    provenance: [...(head?.sources ?? [sourceId])],
    visibility: index.active.get(id)?.messages?.length ? "active" : "omitted",
    origin,
    role: message?.role ?? "custom",
    entry,
  };
}
function rangeContent(content, range) {
  if (!range) return content;
  const texts = textParts(content);
  const part = range.part ?? 0;
  if (!Number.isInteger(part) || part < 0) fail("Range part must be a non-negative integer.");
  const selected = texts.find((item) => item.part === part);
  if (!selected) fail("Requested range does not select a text part; images and non-text content cannot be line-sliced.");
  const lines = selected.text.split("\n");
  const start = range.startLine ?? 1;
  const end = range.endLine ?? lines.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) fail("Requested line range is stale or out of bounds.");
  const excerpt = lines.slice(start - 1, end).join("\n");
  if (typeof content === "string") return excerpt;
  return content.map((item, position) => position === part ? { ...item, text: excerpt } : structuredClone(item));
}
function rangeMetadata(content, range) {
  if (!range) return null;
  const text = textParts(content).find((item) => item.part === (range.part ?? 0))?.text;
  if (text === undefined) fail("Requested range does not select a text part.");
  const count = text.split("\n").length;
  return { part: range.part ?? 0, startLine: range.startLine ?? 1, endLine: range.endLine ?? count };
}
function boundedLimit(limit) {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail(`Search limit must be 1..${MAX_LIMIT}.`);
  return limit;
}

/** Lexical search over bounded candidates on the supplied active branch only. */
export function searchSources(index, state, { query, ids, scope = "active", limit } = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > 500) fail("Search requires a non-empty lexical query of at most 500 characters.");
  if (!["active", "parent", "history", "all"].includes(scope)) fail("Unknown source search scope.");
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 256 || ids.some((id) => typeof id !== "string"))) fail("Search IDs must be a bounded array of source IDs.");
  const maxResults = boundedLimit(limit);
  const needle = query.toLocaleLowerCase();
  const candidates = new Map();
  const includeActive = scope === "active" || scope === "all";
  const includeParent = scope === "parent" || scope === "all";
  const includeHistory = scope === "history" || scope === "all";
  if (includeActive) for (const [id, item] of index.active) {
    if (!item.messages?.length || (ids && !ids.includes(id))) continue;
    candidates.set(id, makeRecord(index, state, id, "active", null));
  }
  if (includeParent) for (const frame of state.frames) for (const saved of frame.saved) {
    if (saved.visible || (ids && !ids.includes(saved.id))) continue;
    if (!candidates.has(saved.id)) candidates.set(saved.id, makeRecord(index, state, saved.id, "parent", saved));
  }
  if (includeHistory) for (const entry of index.branch) {
    const id = entry.id;
    const message = rawMessage(entry);
    if (candidates.has(id) || (ids && !ids.includes(id)) || !["user", "assistant", "toolResult", "custom"].includes(message?.role)) continue;
    if (entry.type === "custom_message" && entry.customType?.startsWith("pi-compass-v2.")) continue;
    candidates.set(id, makeRecord(index, state, id, "history", null));
  }
  const hits = [];
  let scanned = 0;
  for (const record of candidates.values()) {
    if (scanned >= MAX_SCAN || hits.length >= maxResults) break;
    if (!record) continue;
    scanned++;
    const match = textParts(record.content).map((part) => ({ ...part, at: part.text.toLocaleLowerCase().indexOf(needle) })).find((part) => part.at >= 0);
    if (!match) continue;
    const start = Math.max(0, match.at - 160);
    const end = Math.min(match.text.length, match.at + query.length + 240);
    const startLine = match.text.slice(0, match.at).split("\n").length;
    const endLine = match.text.slice(0, match.at + query.length).split("\n").length;
    hits.push({
      id: record.id, binding: record.binding, version: record.version, visibility: record.visibility,
      origin: record.origin, range: { part: match.part, startLine, endLine }, snippet: match.text.slice(start, end), truncated: start > 0 || end < match.text.length,
      caveats: record.caveats, provenance: record.provenance,
    });
    if (hits.length >= maxResults) break;
  }
  return { method: "lexical", scope, query, hits, scanned, truncated: scanned < candidates.size && (hits.length >= maxResults || scanned >= MAX_SCAN) };
}

/** Resolve one exact source version, optionally selecting a line range from one text part. */
export function resolveSource(index, state, { id, binding, version, range } = {}, scope = "active") {
  if (typeof id !== "string" || !id || typeof version !== "string") fail("Resolve requires a source ID and exact version.");
  if (!["active", "parent", "history", "all"].includes(scope)) fail("Unknown source resolution scope.");
  let record = null;
  if (scope === "active" || scope === "all") {
    if (index.active.has(id)) record = makeRecord(index, state, id, "active", null);
  }
  if (!record && (scope === "parent" || scope === "all")) {
    for (const frame of [...state.frames].reverse()) {
      const saved = frame.saved.find((item) => item.id === id && !item.visible);
      if (saved) { record = makeRecord(index, state, id, "parent", saved); break; }
    }
  }
  if (!record && (scope === "history" || scope === "all") && index.byId.has(id)) record = makeRecord(index, state, id, "history", null);
  if (!record) fail(`Source ${id} is not recoverable in scope ${scope}.`);
  if (record.version !== version) fail(`Source ${id} version is stale; requested ${version}, current recoverable version is ${record.version}.`);
  if (binding !== undefined && binding !== record.binding) fail(`Source ${id} binding does not match the requested binding.`);
  const selected = rangeContent(record.content, range);
  return {
    id: record.id, binding: record.binding, version: record.version, range: rangeMetadata(record.content, range),
    content: selected, visibility: record.visibility, origin: record.origin, caveats: record.caveats,
    provenance: record.provenance, truncated: false,
  };
}
