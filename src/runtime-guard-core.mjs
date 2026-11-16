export const GUARD_STATE_TYPE = "runtime-guard.state";
export const GUARD_NOTICE_TYPE = "runtime-guard.notice";
export const GUARD_SCOPES = ["global", "local", "session"];
const MAX_STATE_BYTES = 256 * 1024;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const verdicts = ["pass", "violation", "unknown"];
const ruleKeys = ["id", "tools", "read", "effect", "check", "hint", "sourceRefs", "cases"];

function exact(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${name}: unknown fields ${unknown.join(", ")}.`);
}
function string(value, max, name) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`${name} must be nonempty and <=${max} bytes.`);
  return value.trim();
}
function strings(value, max, name, size = 128) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array with <=${max} items.`);
  const result = value.map((item) => string(item, size, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} contains duplicates.`);
  return result;
}
function boundedJSON(value) {
  let remaining = 65536;
  const visiting = new Set();
  const debit = (bytes) => { remaining -= bytes; if (remaining < 0) throw new Error("Guard selected input exceeds 64 KiB; reduce rule.read."); };
  const copy = (item, depth) => {
    if (depth > 64) throw new Error("Guard input exceeds 64 nesting levels.");
    if (typeof item === "string") {
      if (item.length > remaining) throw new Error("Guard selected input exceeds 64 KiB; reduce rule.read.");
      debit(Buffer.byteLength(JSON.stringify(item)));
      return item;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) { debit(JSON.stringify(item).length); return item; }
    if (!item || typeof item !== "object" || visiting.has(item)) throw new Error("Guard input must be acyclic JSON data.");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("Guard input must be plain JSON data.");
    visiting.add(item);
    debit(2);
    const array = Array.isArray(item);
    if (array && item.length > remaining) throw new Error("Guard selected input exceeds 64 KiB; reduce rule.read.");
    const result = array ? [] : Object.create(null);
    let count = 0;
    const keys = array ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Guard input cannot invoke accessors or contain sparse arrays.");
      if (count++) debit(1);
      if (!array) {
        if (key.length > remaining) throw new Error("Guard selected input exceeds 64 KiB; reduce rule.read.");
        debit(Buffer.byteLength(JSON.stringify(key)) + 1);
      }
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    visiting.delete(item);
    return result;
  };
  const result = copy(value, 0);
  // Escapes can expand strings. Only stringify the already bounded snapshot.
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 65536) throw new Error("Guard selected input exceeds 64 KiB; reduce rule.read.");
  return JSON.parse(json);
}
export function guardCases(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error("cases must contain 1..8 {event,expected} cases.");
  return value.map((item) => {
    exact(item, ["event", "expected"], "case");
    if (!verdicts.includes(item.expected)) throw new Error("case.expected must be pass|violation|unknown.");
    exact(item.event, ["toolName", "input", "cwd", "toolCallId", "parentToolCallId"], "case.event");
    string(item.event.toolName, 128, "case.event.toolName");
    if (item.event.cwd !== undefined) string(item.event.cwd, 4096, "case.event.cwd");
    if (item.event.toolCallId !== undefined) string(item.event.toolCallId, 512, "case.event.toolCallId");
    if (item.event.parentToolCallId !== undefined && item.event.parentToolCallId !== null) string(item.event.parentToolCallId, 512, "case.event.parentToolCallId");
    if (!item.event.input || typeof item.event.input !== "object" || Array.isArray(item.event.input)) throw new Error("case.event.input must be an object.");
    return { expected: item.expected, event: boundedJSON(item.event) };
  });
}
export function normalizeGuardRule(value) {
  exact(value, ruleKeys, "rule");
  const id = string(value.id, 64, "rule.id");
  if (!idPattern.test(id)) throw new Error("rule.id must match [A-Za-z][A-Za-z0-9_-]{0,63}.");
  const tools = strings(value.tools, 16, "rule.tools");
  if (!tools.length) throw new Error("rule.tools needs at least one native name; * explicitly means all tools.");
  const requested = strings(value.read, 16, "rule.read", 160);
  const read = requested.filter((field) => !requested.some((other) => other !== field && field.startsWith(`${other}.`)));
  for (const field of read) {
    const keys = field.split(".");
    if (keys[0] !== "input" || keys.length > 10 || keys.some((key) => !/^[A-Za-z0-9_-]+$/.test(key) || unsafeKeys.has(key))) throw new Error(`Unsafe/unsupported read path: ${field}. Use input or input.field paths.`);
  }
  if (!["warn", "block"].includes(value.effect)) throw new Error("rule.effect must be warn|block.");
  return {
    id, tools, read, effect: value.effect,
    check: string(value.check, 8192, "rule.check"), hint: string(value.hint, 240, "rule.hint"),
    ...(value.sourceRefs !== undefined ? { sourceRefs: strings(value.sourceRefs, 8, "sourceRefs", 512) } : {}),
    ...(value.cases !== undefined ? { cases: guardCases(value.cases) } : {}),
  };
}
export function emptyGuardState() { return { schemaVersion: 1, revision: 0, rules: [] }; }
export function normalizeGuardState(value) {
  exact(value, ["schemaVersion", "revision", "rules"], "guard snapshot");
  if (value.schemaVersion !== 1) throw new Error(`Unsupported guard snapshot schema ${value.schemaVersion}; no reset or migration.`);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Invalid guard revision.");
  if (!Array.isArray(value.rules) || value.rules.length > 32) throw new Error("At most 32 guards per scope.");
  const rules = value.rules.map(normalizeGuardRule);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("Duplicate guard IDs in scope.");
  const state = { schemaVersion: 1, revision: value.revision, rules };
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) throw new Error("Guard scope control budget exceeds 256 KiB.");
  return state;
}
export function projectGuardEvent(rule, event, cwd) {
  const result = { toolName: event.toolName, toolCallId: event.toolCallId ?? "test", parentToolCallId: event.parentToolCallId ?? null, cwd, input: Object.create(null) };
  for (const field of rule.read) {
    const keys = field.split(".");
    let source = event;
    for (const key of keys) {
      const descriptor = source && typeof source === "object" ? Object.getOwnPropertyDescriptor(source, key) : undefined;
      if (descriptor && !Object.hasOwn(descriptor, "value")) throw new Error("Guard input cannot invoke accessors.");
      source = descriptor?.value;
    }
    if (source === undefined) continue;
    if (keys.length === 1) { result.input = source; continue; }
    let target = result;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) target[key] = Object.create(null);
      target = target[key];
    }
    target[keys.at(-1)] = source;
  }
  // Serialize once before crossing the worker boundary: snapshot, not a live
  // reference to Pi-owned input. Never truncate a predicate's observations.
  return boundedJSON(result);
}
export function matchesGuard(rule, toolName) { return rule.tools.includes("*") || rule.tools.includes(toolName); }

export function guardToolSchema() {
  const text = (maxLength = 512) => ({ type: "string", minLength: 1, maxLength });
  const arr = (items, maxItems, minItems = 0) => ({ type: "array", items, minItems, maxItems });
  const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
  const scope = { type: "string", enum: GUARD_SCOPES, description: "session by default; local binds canonical project cwd; global affects this Pi profile." };
  const id = { ...text(64), pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" };
  const revision = { type: "integer", minimum: 0, description: "Scope revision from get/previous receipt, not an individual rule counter." };
  const cases = arr(object({
    event: object({ toolName: text(128), input: { type: "object", additionalProperties: true }, cwd: text(4096), toolCallId: text(512), parentToolCallId: { anyOf: [text(512), { type: "null" }] } }, ["toolName", "input"]),
    expected: { type: "string", enum: verdicts },
  }, ["event", "expected"]), 8, 1);
  const rule = object({
    id, tools: arr(text(128), 16, 1), read: { ...arr(text(160), 16), description: "Only input or dot paths such as input.command enter the VM; native toolName/toolCallId/parentToolCallId/cwd are always included." },
    effect: { type: "string", enum: ["warn", "block"] },
    check: { ...text(8192), description: "Pure JS function e=>({verdict:'pass'|'violation'|'unknown',reason?:string<=240}); e has native call metadata and selected input. No tools/I/O/output/store; VM Date/random are deterministic, not live clocks." },
    hint: { ...text(240), description: "Short corrective advice, sent only on a hit/check failure." },
    sourceRefs: arr(text(512), 8), cases,
  }, ["id", "tools", "read", "effect", "check", "hint"]);
  const action = (name) => ({ type: "string", const: name, enum: [name] });
  return object({ operation: { anyOf: [
    object({ action: action("put"), scope, expectedRevision: revision, rule }, ["action", "expectedRevision", "rule"]),
    object({ action: action("remove"), scope, expectedRevision: revision, id }, ["action", "expectedRevision", "id"]),
    object({ action: action("get"), scope, id, cursor: text(64) }, ["action"]),
    object({ action: action("test"), scope, id, cases }, ["action", "id", "cases"]),
  ] } }, ["operation"]);
}
