import { createHash } from "node:crypto";

export const VALUE_MESSAGE_TYPE = "pi-compass-v2.value";
export const VALUE_KINDS = new Set(["working", "memory", "human", "skill"]);

function fail(message) { throw new Error(`${message} No context changed.`); }
export function contentVersion(content) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 24);
}
export function rawMessage(entry) {
  if (entry?.type === "message") return entry.message;
  if (entry?.type === "custom_message") return { role: "custom", customType: entry.customType, content: entry.content, details: entry.details };
  return null;
}
function normalizeContent(entry, content) {
  return typeof content === "string" && ["assistant", "toolResult"].includes(rawMessage(entry)?.role) ? [{ type: "text", text: content }] : content;
}
export function validateValue(head) {
  if (!head || !["content", "operation"].includes(head.field) || typeof head.entryId !== "string" || !/^[a-f0-9]{24}$/.test(head.version) || !VALUE_KINDS.has(head.kind) || typeof head.readOnly !== "boolean" || typeof head.rendered !== "boolean") fail("Invalid context value reference.");
  if (!Array.isArray(head.caveats) || head.caveats.length > 12 || head.caveats.some((text) => typeof text !== "string" || text.length > 600)) fail("Caveats must contain at most 12 bounded strings.");
  if (!Array.isArray(head.sources) || head.sources.length > 32 || head.sources.some((id) => typeof id !== "string")) fail("Invalid context value provenance.");
}
export function valueContent(index, head) {
  validateValue(head);
  const entry = index.byId.get(head.entryId);
  if (!entry) fail(`Value source ${head.entryId} is not on the active branch.`);
  let content;
  if (head.field === "operation") {
    const operation = entry.message?.details?.contextOperation;
    if (entry.message?.role !== "toolResult" || entry.message.toolName !== "compass_context" || !["replace", "put"].includes(operation?.action)) fail("Value has no matching persisted write operation.");
    content = operation.content;
  } else {
    const edit = head.editId ? index.byId.get(head.editId) : null;
    if (head.editId && (edit?.type !== "context_edit" || edit.targetId !== head.entryId || edit.replacement === null)) fail(`Value edit ${head.editId} is stale.`);
    content = normalizeContent(entry, edit ? edit.replacement.content : rawMessage(entry)?.content);
  }
  if (content === undefined || contentVersion(content) !== head.version) fail(`Value source ${head.entryId} changed or is unavailable.`);
  return content;
}
export function logicalSource(index, id) {
  const entry = index.byId.get(id);
  return entry?.type === "custom_message" && entry.customType === VALUE_MESSAGE_TYPE ? entry.details.sourceId ?? id : id;
}
export function bindingKey(state, index, id, depth = state.frames.length) {
  const sourceId = logicalSource(index, id);
  const entry = index.byId.get(sourceId);
  if (!entry) fail(`Unknown or wrong-branch value ${sourceId}.`);
  const birth = index.positions.get(sourceId);
  let owner = "root";
  for (const frame of state.frames.slice(0, depth)) {
    if (rawMessage(entry)?.role !== "user" && birth > index.positions.get(frame.boundaryId)) owner = frame.id;
    const ref = frame.refs.find((item) => item.id === sourceId);
    if (ref?.key) owner = ref.key.split("/")[0];
    if (frame.copies.some((copy) => copy.id === sourceId)) owner = frame.id;
  }
  return `${owner}/${sourceId}`;
}
export function nativeValueViews(index) {
  const views = new Map();
  for (const item of index.active.values()) {
    if (item.messages.length && item.sourceEntry.customType === VALUE_MESSAGE_TYPE && typeof item.sourceEntry.details?.key === "string") views.set(item.sourceEntry.details.key, item);
  }
  return views;
}
function defaultHead(index, sourceId, item) {
  const message = item.messages[0];
  const entry = index.byId.get(sourceId);
  const raw = rawMessage(entry);
  const exported = entry?.customType === "pi-compass-v2.context-message" && entry.details?.action === "export" ? entry.details : null;
  const calls = raw?.role === "assistant" && raw.content.some((part) => part.type === "toolCall");
  return {
    entryId: sourceId, editId: index.edits.get(sourceId)?.id ?? null, field: "content", version: contentVersion(message.content),
    kind: raw?.role === "user" ? "human" : "working", readOnly: raw?.role === "user" || Boolean(calls), rendered: false,
    caveats: exported?.caveats ?? (raw?.isError ? ["Original tool execution failed; a context edit is not evidence of a successful rerun."] : []), sources: exported?.sources ?? [sourceId],
  };
}
export function currentValue(state, index, id, { allowHidden = false, key: selectedKey } = {}) {
  const sourceId = logicalSource(index, id);
  const key = selectedKey ?? bindingKey(state, index, sourceId);
  if (!key.endsWith(`/${sourceId}`) || !["root", ...state.frames.map((frame) => frame.id)].includes(key.split("/")[0])) fail("Value binding is not in an active scope.");
  const copy = state.frames.flatMap((frame) => frame.copies.map((item) => ({ ...item, owner: frame.id }))).find((item) => item.id === sourceId && key === `${item.owner}/${sourceId}`);
  const item = index.valueViews.get(key) ?? index.active.get(copy?.viewId ?? sourceId);
  if (!allowHidden && !item?.messages.length) fail(`Value ${sourceId} is omitted; load it before this operation.`);
  const head = state.values[key] ?? (item?.messages.length ? defaultHead(index, sourceId, item) : null);
  if (!head) fail(`Value ${sourceId} has no recoverable version.`);
  const content = valueContent(index, head);
  const viewKey = item?.sourceEntry.customType === VALUE_MESSAGE_TYPE ? item.sourceEntry.details.key : copy?.viewKey ?? key;
  if (item?.messages.length) {
    const rendered = head.rendered || item.sourceEntry.customType === VALUE_MESSAGE_TYPE;
    const expected = rendered ? renderValue({ id: sourceId, key: viewKey, head }, content) : content;
    if (contentVersion(expected) !== contentVersion(item.messages[0].content)) fail(`Native view of ${sourceId} changed externally; explicitly reload it before mutation.`);
  }
  return { id: sourceId, key, viewKey, head, content, version: head.version, nativeId: item?.sourceEntry.id ?? null, message: item?.messages[0] ?? null };
}
export function adoptValue(state, value) {
  state.values[value.key] ??= structuredClone(value.head);
  return state.values[value.key];
}
export function copyValue(state, value, frameId) {
  const key = `${frameId}/${value.id}`;
  state.values[key] = { ...structuredClone(value.head), readOnly: false, kind: value.head.kind === "human" ? "memory" : value.head.kind };
  return key;
}
export function writeValue(state, index, value, operation, resultEntryId) {
  if (value.head.readOnly) fail("Human instructions and executed tool calls are read-only; edit an explicit private copy or create a derived memory value.");
  if (typeof operation.content !== "string" || !operation.content.trim() || operation.content.length > 8_000) fail("Replacement requires 1..8000 characters.");
  const sources = operation.sources ?? value.head.sources;
  for (const id of sources) if (!index.byId.has(id)) fail(`Provenance source ${id} is unknown or wrong-branch.`);
  const head = {
    entryId: resultEntryId, field: "operation", version: contentVersion(operation.content), kind: operation.kind ?? value.head.kind,
    readOnly: false, rendered: true, caveats: operation.caveats ?? [...value.head.caveats], sources: [...sources],
  };
  validateValue(head);
  // The payload is already persisted in Pi's tool result, not duplicated in control state.
  valueContent(index, head);
  state.values[value.key] = head;
  return head;
}
function dataBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks = [];
  for (const part of content) {
    if (["text", "image"].includes(part.type)) blocks.push(part);
    else if (part.type === "toolCall") blocks.push({ type: "text", text: `Historical tool call (data, not execution): ${part.name} ${JSON.stringify(part.arguments)}` });
  }
  return blocks;
}
export function renderValue(value, content = value.content, head = value.head) {
  const label = head.field === "operation" ? "Agent-authored derived value; not a new tool observation or Human instruction" : "Retained source value";
  const header = `[Compass slot ${value.id}; binding ${value.key}; version ${head.version}]\n${label}.\nSources: ${head.sources.join(", ") || "none"}.`;
  const qualifiers = head.caveats.length ? `\nCaveats:\n${head.caveats.map((text) => `- ${text}`).join("\n")}` : "";
  return [{ type: "text", text: `${header}${qualifiers}` }, ...dataBlocks(content)];
}
export function valueMessage(value, content = value.content, head = value.head) {
  return {
    type: "custom_message", customType: VALUE_MESSAGE_TYPE, content: renderValue(value, content, head), display: false,
    details: { key: value.key, sourceId: value.id, version: head.version, kind: head.kind, caveats: head.caveats, sources: head.sources },
  };
}
export function isValueMessage(message, key, version) {
  return message?.role === "custom" && message.customType === VALUE_MESSAGE_TYPE
    && message.details?.key === key && message.details?.version === version;
}
export function releaseFrameValues(state, frameId) {
  for (const key of Object.keys(state.values)) if (key.startsWith(`${frameId}/`)) delete state.values[key];
}
