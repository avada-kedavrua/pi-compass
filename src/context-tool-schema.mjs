const string = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items, maxItems, minItems = 0) => ({ type: "array", items, minItems, maxItems, uniqueItems: true });
const choice = (...values) => ({ type: "string", enum: values });
const tag = (value) => ({ type: "string", enum: [value], const: value });
const ref = string(256, { minLength: 1, description: "Opaque source ref returned by Compass; copy unchanged." });
const sources = array(ref, 64, 1);
const range = { ...object({ part: { type: "integer", minimum: 0 }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, []), description: "Lines of the recovered source content, not absolute file line numbers." };
const caveats = { ...array(string(600), 12), description: "Adds qualifications; inherited caveats are preserved." };
const lifetime = { ...choice("goal", "session"), description: "Default: current Goal, or session when no Goal exists. Explicit goal requires an existing Goal." };
const operation = (action, fields = {}, required = []) => object({ action: tag(action), ...fields }, ["action", ...required]);

export function contextSearchSchema() {
  return object({
    query: string(400, { description: "Literal keywords; any match by default. Omit when recovering known refs." }),
    refs: array(ref, 64),
    sourceScope: { ...choice("active", "parent", "history", "all"), description: "Default active for query; all available scopes for exact refs." },
    limit: { type: "integer", minimum: 1, maximum: 16 },
    match: choice("any", "all"),
    view: { ...choice("snippets", "handles", "details"), description: "Default snippets: short previews. handles omits text; details adds source qualifications, not a full-body read." },
  }, []);
}

/** Common retention stays small; rare attention/edit operations load explicitly. */
export function contextToolSchema(extended = false) {
  const operations = [
    operation("pin", { sources, lifetime, caveats, skill: { type: "boolean" } }, ["sources"]),
    operation("unpin", { sources }, ["sources"]),
    operation("remember", { text: string(4000, { minLength: 1, description: "Your compact working memory, not a new tool observation or Human instruction." }), sources: array(ref, 32), caveats, lifetime }, ["text"]),
  ];
  if (extended) operations.push(
    operation("call", { task: string(4000, { minLength: 1, description: "Same-session attention frame, not a child Agent or filesystem rollback." }), capture: { ...array(object({ ref, mode: { ...choice("ref", "copy"), description: "ref shares the enclosing value; copy is private. Edit copies only through the new refs returned by call." } }, ["ref", "mode"]), 64), description: "Default none. Applied receipt sources correspond to this order; copies have new refs." } }, ["task"]),
    operation("return", { result: string(8000), exportSources: { ...array(ref, 64), description: "Only selected values are exported. Other local work is released; writes through shared refs survive." } }),
    operation("load", { source: ref, range }, ["source"]),
    operation("replace", { source: ref, text: string(8000, { minLength: 1, description: "Agent-derived replacement. Human originals and executed calls require a private copy. Unpin a pinned value before editing. Use the applied receipt's updated ref for subsequent operations." }), caveats }, ["source", "text"]),
    operation("drop", { sources }, ["sources"]),
    operation("mark", { source: ref, handling: choice("active", "handled", "retired"), reason: string(600, { minLength: 1 }) }, ["source", "handling", "reason"]),
    operation("move", { sources, range, verifiedAgainst: ref }, ["sources"]),
    operation("spill", { source: ref, path: string(500, { minLength: 1, description: "New project-relative artifact, no overwrite. Use the applied updated ref for verified recovery." }), purpose: string(1000, { minLength: 1 }) }, ["source", "path", "purpose"]),
    operation("transfer", { watchIds: array(string(128, { minLength: 1 }), 8, 1), target: choice("parent", "root") }, ["watchIds", "target"]),
  );
  return object({ operation: { anyOf: operations } }, ["operation"]);
}
