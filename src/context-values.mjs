import { createHash } from "node:crypto";
import { normalizeQuestionnaireRecord } from "./questionnaire-integration.mjs";

// Retired Compass-internal transcript messages from earlier releases: never
// model input, never an editable context source.
export const RESERVED_CUSTOM_TYPES = Object.freeze(["pi-compass-v2.goalrun-state", "pi-compass-v2.goalrun-anchor", "pi-compass-v2.conventions"]);

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
function isSkillPath(path) {
  if (typeof path !== "string") return false;
  const normalized = path.toLowerCase().split(String.fromCharCode(92)).join("/");
  return normalized === "skill.md" || normalized.endsWith("/skill.md") || normalized.includes("/skills/");
}
export function sourceQualifications(entry, call = null, exchangeComplete = false) {
  const message = rawMessage(entry);
  const caveats = [];
  if (message?.isError || message?.details?.error) caveats.push("Original tool execution failed; a context view is not evidence of a successful rerun.");
  else if (message?.role === "toolResult" && message.isError !== false) caveats.push("Original tool result has no explicit success status; do not treat it as verified execution evidence.");
  if (message?.details?.truncation?.truncated === true) caveats.push("Original tool output was truncated; this source is not evidence that the full content was read.");
  let readStatus;
  if (message?.role === "toolResult" && message.toolName === "read" && call?.name === "read") {
    const args = call.arguments ?? {};
    const range = args.range && typeof args.range === "object" ? args.range : {};
    const requestedStart = range.startLine ?? args.startLine ?? args.offset ?? 1;
    const startLine = Number.isSafeInteger(requestedStart) && requestedStart >= 1 ? requestedStart : 0;
    const endLine = range.endLine ?? args.endLine;
    const limit = range.limit ?? args.limit;
    const truncated = message.details?.truncation?.truncated === true || (message.details?.truncation && message.details.truncation.truncated !== false);
    const failed = message.isError === true || Boolean(message.details?.error);
    const status = failed ? "failed" : truncated ? "truncated" : message.isError === false ? "complete" : "unknown";
    const content = normalizeContent(entry, message.content);
    readStatus = {
      sourceId: entry.id, payloadVersion: contentVersion(content), status, exchangeComplete,
      path: typeof args.path === "string" ? args.path.slice(0, 1000) : "",
      range: { startLine, ...(endLine !== undefined ? { endLine } : {}), ...(limit !== undefined ? { limit } : {}) },
      fullSkillFile: status === "complete" && exchangeComplete && isSkillPath(args.path) && startLine === 1 && endLine === undefined && limit === undefined,
    };
  }
  return { caveats, ...(readStatus ? { readStatus } : {}) };
}
export function validateValue(head) {
  if (!head || !["content", "operation", "snapshot", "questionnaire"].includes(head.field) || typeof head.entryId !== "string" || !/^[a-f0-9]{24}$/.test(head.version) || !VALUE_KINDS.has(head.kind) || typeof head.readOnly !== "boolean" || typeof head.rendered !== "boolean") fail("Invalid context value reference.");
  if (head.pointerVersion !== undefined && !/^[a-f0-9]{24}$/.test(head.pointerVersion)) fail("Invalid source pointer version.");
  if (!["active", "handled", "retired"].includes(head.handling)) fail("Invalid context handling state.");
  if (head.handlingReason !== undefined && (typeof head.handlingReason !== "string" || head.handlingReason.length > 600)) fail("Invalid handling reason.");
  if (!Array.isArray(head.caveats) || head.caveats.length > 12 || head.caveats.some((text) => typeof text !== "string" || text.length > 600)) fail("Caveats must contain at most 12 bounded strings.");
  if (!Array.isArray(head.sources) || head.sources.length > 32 || head.sources.some((id) => typeof id !== "string")) fail("Invalid context value provenance.");
  if (head.readStatus !== undefined && (!head.readStatus || typeof head.readStatus !== "object" || !["complete", "failed", "truncated", "unknown"].includes(head.readStatus.status) || typeof head.readStatus.sourceId !== "string" || !/^[a-f0-9]{24}$/.test(head.readStatus.payloadVersion) || typeof head.readStatus.path !== "string" || typeof head.readStatus.fullSkillFile !== "boolean" || typeof head.readStatus.exchangeComplete !== "boolean" || !head.readStatus.range || !Number.isSafeInteger(head.readStatus.range.startLine))) fail("Invalid immutable read-status qualification.");
}
export function valueBinding(key) {
  if (typeof key !== "string" || key.length > 129) fail("Invalid context value binding.");
  const separator = key.indexOf("/");
  const owner = key.slice(0, separator);
  const sourceId = key.slice(separator + 1);
  if (separator < 1 || !sourceId || sourceId.includes("/")) fail("Invalid context value binding.");
  return { owner, sourceId };
}

/** Opaque, stateless selection: native binding plus the exact content version. */
export function contextRef({ binding, version }) {
  valueBinding(binding);
  if (!/^[a-f0-9]{24}$/.test(version)) throw new Error("Invalid source version.");
  return `S.${Buffer.concat([Buffer.from(binding), Buffer.from([0]), Buffer.from(version, "hex")]).toString("base64url")}`;
}
export function contextSelection(ref) {
  if (typeof ref !== "string" || ref.length > 256 || !/^S\.[A-Za-z0-9_-]+$/.test(ref)) throw new Error("Copy a source ref returned by Compass unchanged; do not invent a binding or scope. No context changed.");
  const bytes = Buffer.from(ref.slice(2), "base64url");
  if (bytes.length < 15 || bytes.at(-13) !== 0 || bytes.toString("base64url") !== ref.slice(2)) throw new Error("Invalid source ref; search again. No context changed.");
  let binding;
  try { binding = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -13)); }
  catch { throw new Error("Invalid source ref; search again. No context changed."); }
  const { sourceId: id } = valueBinding(binding);
  return { id, binding, version: bytes.subarray(-12).toString("hex") };
}

// Binding identity comes from the immutable native source/write record, never
// provenance: a derived value may intentionally cite entirely different sources.
export function valueContent(index, head, sourceId) {
  validateValue(head);
  if (typeof sourceId !== "string" || !sourceId) fail("A logical value source is required.");
  const entry = index.byId.get(head.entryId);
  if (!entry) fail(`Value source ${head.entryId} is not on the active branch.`);
  let content;
  if (head.field === "operation") {
    const operation = entry.message?.details?.contextOperation;
    if (entry.message?.role !== "toolResult" || entry.message.toolName !== "compass_context" || !["replace", "spill", "move"].includes(operation?.action)) fail("Value has no matching persisted write operation.");
    if (!Array.isArray(operation.ids) || !operation.ids.some((id) => logicalSource(index, id) === sourceId)) fail("Value binding does not match its persisted write source.");
    content = operation.action === "spill" ? operation.pointer : operation.action === "move" ? operation.remaining : operation.content;
  } else if (head.field === "questionnaire") {
    if (entry.id !== sourceId) fail("Value binding does not match its native questionnaire source.");
    content = questionnaireContent(entry);
    if (!content) fail("Questionnaire source is not a genuine structured Human answer.");
  } else if (head.field === "snapshot") {
    if (entry.type !== "custom_message" || entry.customType !== VALUE_MESSAGE_TYPE || !entry.details?.derived || !Array.isArray(entry.content)) fail("Value has no matching native data snapshot.");
    if (entry.details.sourceId !== sourceId) fail("Value binding does not match its native snapshot source.");
    content = entry.content.slice(1);
  } else {
    if (entry.id !== sourceId) fail("Value binding does not match its native content source.");
    const edit = head.editId ? index.byId.get(head.editId) : null;
    if (head.editId && (edit?.type !== "context_edit" || edit.targetId !== head.entryId || edit.replacement === null)) fail(`Value edit ${head.editId} is stale.`);
    content = normalizeContent(entry, edit ? edit.replacement.content : rawMessage(entry)?.content);
  }
  if (content === undefined || contentVersion(content) !== head.version) fail(`Value source ${head.entryId} changed or is unavailable.`);
  return content;
}
export function questionnaireContent(entry) {
  const message = rawMessage(entry);
  if (message?.role !== "toolResult" || !/ask.*user.*question|ask_user_question/i.test(message.toolName) || message.isError || message.details?.error) return null;
  const questionnaire = normalizeQuestionnaireRecord(message.details, { preserveFullText: true });
  return questionnaire ? [{ type: "text", text: `Historical Human questionnaire (${questionnaire.outcome}); not a new Human message:\n${JSON.stringify(questionnaire)}` }] : null;
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
  const human = rawMessage(entry)?.role === "user" || state.values[`root/${sourceId}`]?.field === "questionnaire";
  let owner = "root";
  for (const frame of state.frames.slice(0, depth)) {
    if (!human && birth > index.positions.get(frame.boundaryId)) owner = frame.id;
    const ref = frame.refs.find((item) => item.id === sourceId);
    if (ref?.key) owner = ref.key.split("/")[0];
    if (frame.copies.some((copy) => copy.id === sourceId)) owner = frame.id;
  }
  return `${owner}/${sourceId}`;
}
export function sourceEntries(branch) {
  const entries = new Map();
  for (const entry of branch) {
    entries.set(entry.id, entry);
    if (entry.customType === VALUE_MESSAGE_TYPE && typeof entry.details?.referenceId === "string") {
      entries.set(entry.details.referenceId, entry);
      if (entry.details.derived) entries.set(entry.details.sourceId, entry);
    }
  }
  return entries;
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
  if (entry?.customType === VALUE_MESSAGE_TYPE && entry.details?.derived) return snapshotHead(entry);
  const group = index.groups?.get(entry.id);
  const exchangeComplete = Boolean(group && !group.duplicate && group.calls.size === group.results.size);
  const qualification = sourceQualifications(entry, index.readRequests?.get(entry.id), exchangeComplete);
  const calls = raw?.role === "assistant" && Array.isArray(raw.content) && raw.content.some((part) => part.type === "toolCall");
  return {
    entryId: entry.id, editId: index.edits.get(entry.id)?.id ?? null, field: "content", version: contentVersion(message.content),
    kind: raw?.role === "user" ? "human" : "working", readOnly: raw?.role === "user" || Boolean(calls), rendered: false, handling: "active",
    caveats: qualification.caveats, sources: [sourceId],
    ...(qualification.readStatus ? { readStatus: qualification.readStatus } : {}),
  };
}
export function snapshotHead(entry) {
  return {
    entryId: entry.id, field: "snapshot", version: entry.details.version, kind: entry.details.kind,
    readOnly: false, rendered: true, handling: entry.details.handling, caveats: [...entry.details.caveats], sources: [...entry.details.sources],
    origin: structuredClone(entry.details.origin),
    ...(entry.details.readStatus ? { readStatus: structuredClone(entry.details.readStatus) } : {}),
  };
}
export function currentValue(state, index, id, { allowHidden = false, key: selectedKey } = {}) {
  const sourceId = logicalSource(index, id);
  const key = selectedKey ?? bindingKey(state, index, sourceId);
  const binding = valueBinding(key);
  if (binding.sourceId !== sourceId || (binding.owner !== "root" && !state.frames.some((frame) => frame.id === binding.owner))) fail("Value binding is not in an active scope.");
  const copy = state.frames.find((frame) => frame.id === binding.owner)?.copies.find((item) => item.id === sourceId);
  let item = index.valueViews.get(key) ?? index.active.get(copy?.viewId ?? index.byId.get(sourceId)?.id);
  if (state.values[key]?.pointerVersion && item?.messages?.length && contentVersion(item.messages[0].content) === state.values[key].pointerVersion) item = undefined;
  if (!allowHidden && !item?.messages.length) fail(`Value ${sourceId} is omitted; load it before this operation.`);
  const entry = index.byId.get(sourceId);
  const persistedExport = allowHidden && entry?.customType === VALUE_MESSAGE_TYPE && entry.details?.action === "export" && entry.details.key === key;
  if (persistedExport && !item?.messages.length && !state.values[key] && index.branch.findLast((candidate) => candidate.type === "context_edit" && candidate.targetId === entry.id)?.replacement === null) fail(`Export ${sourceId} was dropped or is not available in this projection.`);
  let head = state.values[key];
  if (!head && item?.messages.length) head = defaultHead(index, sourceId, item);
  if (!head && persistedExport) head = snapshotHead(entry);
  if (!head) fail(`Value ${sourceId} has no recoverable version.`);
  const content = valueContent(index, head, sourceId);
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
    readOnly: false, rendered: true, handling: "active", caveats: [...new Set([...value.head.caveats, ...(operation.caveats ?? [])])], sources: [...sources],
    ...(value.head.origin ? { origin: structuredClone(value.head.origin) } : {}),
    ...(value.head.readStatus ? { readStatus: structuredClone(value.head.readStatus) } : {}),
  };
  validateValue(head);
  // The payload is already persisted in Pi's tool result, not duplicated in control state.
  valueContent(index, head, value.id);
  state.values[value.key] = head;
  return head;
}
export function dataBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks = [];
  for (const part of content) {
    if (["text", "image"].includes(part.type)) blocks.push(part);
    else if (part.type === "toolCall") blocks.push({ type: "text", text: `Historical tool call (data, not execution): ${part.name} ${JSON.stringify(part.arguments)}` });
  }
  return blocks;
}
export function agentAuthored(head) {
  return head?.field === "operation" || head?.origin?.authorship === "agent-memory";
}
export function renderValue(value, content = value.content, head = value.head) {
  const label = agentAuthored(head) ? "Agent-authored derived value; not a new tool observation or Human instruction" : head.field === "snapshot" ? "Selected source data; not a new tool execution or Human message" : "Retained source value";
  const handling = head.handling !== "active" ? `\nHandling: ${head.handling}. ${head.handlingReason ?? ""}` : "";
  const header = `[Compass ${contextRef({ binding: value.key, version: head.version })}] ${label}.${handling}`;
  const qualifiers = head.caveats.length ? `\nCaveats:\n${head.caveats.map((text) => `- ${text}`).join("\n")}` : "";
  return [{ type: "text", text: `${header}${qualifiers}` }, ...dataBlocks(content)];
}
export function valueMessage(value, content = value.content, head = value.head) {
  return {
    type: "custom_message", customType: VALUE_MESSAGE_TYPE, content: structuredClone(renderValue(value, content, head)), display: false,
    details: { key: value.key, sourceId: value.id, version: head.version, kind: head.kind, handling: head.handling, caveats: [...head.caveats], sources: [...head.sources], ...(head.readStatus ? { readStatus: structuredClone(head.readStatus) } : {}) },
  };
}
export function isValueMessage(message, key, version) {
  return message?.role === "custom" && message.customType === VALUE_MESSAGE_TYPE
    && message.details?.key === key && message.details?.version === version;
}
export function releaseFrameValues(state, frameId) {
  for (const key of Object.keys(state.values)) if (key.startsWith(`${frameId}/`)) delete state.values[key];
}
