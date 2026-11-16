// A root object survives Pi's provider adapters; the nested union makes each
// mutation's required and permitted fields visible to models and native validation.
const string = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items, maxItems, minItems = 0) => ({ type: "array", items, minItems, maxItems, uniqueItems: true });
const choice = (...values) => ({ type: "string", enum: values });
// enum survives provider conversion; const lets Pi report the selected branch's
// missing fields instead of suggesting a different action on invalid inputs.
const tag = (value) => ({ type: "string", enum: [value], const: value });
const id = string(64, { minLength: 1 });
const version = string(24, { pattern: "^[a-f0-9]{24}$" });
const binding = string(129, { minLength: 1 });
const revision = { type: "integer", minimum: 0 };
const range = object({ part: { type: "integer", minimum: 0 }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, []);
const selected = object({ id, version, binding, range }, ["id", "version"]);
const sourceScope = choice("active", "parent", "history", "all");
const ids = array(id, 64, 1);
const oneId = array(id, 1, 1);
const versions = array(object({ id, version }, ["id", "version"]), 64, 1);
const metadata = { kind: choice("working", "memory", "human", "skill"), caveats: array(string(600), 12), sources: array(id, 32) };
const operation = (action, fields = {}, required = []) => object({ action: tag(action), expectedRevision: revision, ...fields }, ["action", "expectedRevision", ...required]);

export function contextSearchSchema() {
  return object({
    query: string(400, { description: "Literal whitespace-separated keywords; any by default, not semantic inference." }),
    sourceScope,
    ids: array(id, 64),
    limit: { type: "integer", minimum: 1, maximum: 16 },
    match: choice("any", "all"),
    compare: array(selected, 16),
    rankedSources: array(selected, 16),
  }, []);
}

export function contextToolSchema() {
  const move = { type: "object", properties: { action: tag("move") }, required: ["action"], anyOf: [
    operation("move", { ids: oneId, version, binding, sourceScope, verifiedAgainst: object({ id, version, binding }, ["id", "version"]) }, ["ids", "version"]),
    operation("move", { ids: oneId, version, binding, sourceScope, range }, ["ids", "version", "range"]),
    operation("move", { ids: array(id, 64, 2), versions: { ...versions, minItems: 2 } }, ["ids", "versions"]),
  ] };
  return object({
    operation: { anyOf: [
      operation("call", {
        task: string(4000, { minLength: 1, description: "Local objective; capture/export default none." }),
        capture: array(object({ id, version, binding, mode: choice("ref", "copy") }, ["id", "version", "mode"]), 64),
      }, ["task"]),
      operation("return", { result: string(8000), exportIds: array(id, 64) }),
      operation("pin", { ids, binding, scope: id, lifetime: choice("goal", "session"), kind: metadata.kind, caveats: metadata.caveats }, ["ids"]),
      operation("unpin", { ids, binding, scope: id }, ["ids"]),
      operation("mark", { ids: oneId, version, binding, handling: choice("active", "handled", "retired"), reason: string(600, { minLength: 1 }) }, ["ids", "version", "handling", "reason"]),
      operation("load", { ids: oneId, version, binding, sourceScope, range }, ["ids", "version"]),
      operation("replace", { ids: oneId, version, binding, content: string(8000, { minLength: 1 }), ...metadata }, ["ids", "version", "content"]),
      operation("drop", { ids, versions, binding }, ["ids", "versions"]),
      move,
      operation("spill", { ids: oneId, version, binding, path: string(500, { minLength: 1, description: "New project-relative artifact; no overwrite or symlinks." }), purpose: string(1000, { minLength: 1 }) }, ["ids", "version", "path", "purpose"]),
      operation("transfer", { watchIds: array(string(128, { minLength: 1 }), 8, 1), watchScope: id }, ["watchIds", "watchScope"]),
    ] },
  }, ["operation"]);
}
