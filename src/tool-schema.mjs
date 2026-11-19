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
const taskId = string(40, { minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,39}$" });
const operation = (action, fields = {}, required = []) => object({ action: tag(action), ...fields }, ["action", ...required]);

function actions(cases) {
  const properties = {};
  for (const variant of cases) for (const [key, schema] of Object.entries(variant.properties)) {
    const old = properties[key];
    if (!old) properties[key] = schema;
    else if (JSON.stringify(old) !== JSON.stringify(schema)) {
      const variants = old.anyOf ?? [old];
      if (!variants.some((item) => JSON.stringify(item) === JSON.stringify(schema))) properties[key] = { anyOf: [...variants, schema] };
    }
  }
  properties.action = choice(...cases.map((item) => item.properties.action.const));
  return { ...object(properties, ["action"]), anyOf: cases };
}

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

/** Stable operation schema; context is a model-only native-boundary tool. */
export function contextToolSchema() {
  const operations = [
    operation("pin", { sources, lifetime, caveats, skill: { type: "boolean" } }, ["sources"]),
    operation("unpin", { sources }, ["sources"]),
    operation("remember", { text: string(4000, { minLength: 1, description: "Your compact working memory, not a new tool observation or Human instruction." }), sources: array(ref, 32), caveats, lifetime }, ["text"]),

    operation("call", { taskId, task: string(4000, { minLength: 1, description: "Same-session attention frame, not a child Agent or filesystem rollback." }), capture: { ...array(object({ ref, mode: { ...choice("ref", "copy"), description: "ref borrows read-only; copy is private and editable using its returned ref." } }, ["ref", "mode"]), 64), description: "Default none. Applied receipt sources correspond to this order; copies have new refs." } }),
    operation("return", { outcome: { ...object({ status: choice("done", "blocked", "throw"), evidence: string(1600, { minLength: 1 }), reason: string(600, { minLength: 1 }), sideEffects: string(800, { minLength: 1 }) }, ["status"]), description: "Only for a parent DAG node frame opened with taskId. Omit for an ordinary frame opened with task." }, result: string(8000), exportSources: { ...array(ref, 64), description: "Only selected values export; retained values keep their lifetime in the parent. Other local work releases." } }),
    operation("load", { source: ref, range }, ["source"]),
    operation("replace", { source: ref, text: string(8000, { minLength: 1, description: "Agent-derived replacement. Human originals and executed calls require a private copy. Edit retained memory directly; unpin originals before editing eligible working values. Use the applied receipt's updated ref for subsequent operations." }), caveats }, ["source", "text"]),
    operation("drop", { sources }, ["sources"]),
    operation("mark", { source: ref, handling: choice("active", "handled", "retired"), reason: string(600, { minLength: 1 }) }, ["source", "handling", "reason"]),
    operation("move", { sources, range, verifiedAgainst: ref }, ["sources"]),
    operation("spill", { source: ref, path: string(500, { minLength: 1, description: "New project-relative artifact, no overwrite. Use the applied updated ref for verified recovery." }), purpose: string(1000, { minLength: 1 }) }, ["source", "path", "purpose"]),
    operation("transfer", { watchIds: array(string(128, { minLength: 1 }), 8, 1), target: choice("parent", "root") }, ["watchIds", "target"]),
  ];
  return actions(operations);
}

const evidence = string(1600, { minLength: 1 });
const reason = string(600, { minLength: 1 });
const criterion = string(24, { minLength: 1 });
const task = object({
  id: taskId, title: string(200, { minLength: 1 }), dependsOn: array(taskId, 24), acceptance: string(400, { minLength: 1 }),
  executor: { ...choice("parent", "code", "subagent"), description: "Default parent. code means deterministic parent Code Mode; subagent must be read-only." },
  agent: choice("scout", "researcher", "reviewer", "evidence-auditor", "delegate", "oracle"),
  output: string(400), writeScope: string(200), dispatchReason: string(400, { minLength: 12, description: "Required for subagent: why another semantic context is worth its cost." }),
  fromTasks: array(taskId, 8), inputRefs: array(ref, 8),
  frameScope: string(64),
}, ["id", "title", "acceptance"]);
const taskPatch = object(task.properties, ["id"]);
const definitionEdit = (length) => object({ id: string(32, { minLength: 1, description: "Only update/remove an existing ID returned by Compass. Omit id to add; Compass assigns it." }), text: string(length, { minLength: 1, description: "New text. Omit text to remove the existing ID." }) }, []);
const assessment = { status: choice("pass", "fail", "inconclusive"), evidence, caveats: array(string(400), 8), unresolvedCaveats: array(string(400), 8) };

export const toolSchemas = {
  compass_goal: actions([
    operation("set", {
      current: string(4000, { minLength: 1 }), constraints: array(string(600, { minLength: 1 }), 24), sources: array(ref, 16, 1),
      criteria: { ...array(string(300, { minLength: 1 }), 12), description: "Only definition owner. Complete list when supplied; omission preserves current criteria, [] clears. Human refs define the actual objective/constraints, not merely the latest follow-up." },
    }, ["current", "constraints", "sources"]),
    operation("update", { constraintEdits: array(definitionEdit(600), 24, 1), criterionEdits: array(definitionEdit(300), 12, 1) }),
    operation("decide", { summary: string(320, { minLength: 1 }), rationale: string(500), evidence: string(900), supersedes: array(string(32, { minLength: 1 }), 8), taskIds: array(taskId, 24) }, ["summary"]),
    operation("checkpoint", { ref: string(500, { minLength: 1, description: "Real recoverable Git/artifact reference; not an automatic snapshot or rollback." }), note: string(320) }, ["ref"]),
  ]),
  compass_state: object({
    view: { ...choice("summary", "goal", "plan", "acceptance", "history", "execution", "retained"), description: "Default compact summary. Other views return complete requested domain evidence. Read-only; no tool loading." },
    cursor: string(80, { minLength: 1, description: "Opaque previous cursor; copy unchanged for summary deltas." }),
    limit: { type: "integer", minimum: 1, maximum: 20 },
  }, []),
  compass_context_search: contextSearchSchema(),
  compass_context: contextToolSchema(),
  compass_plan: actions([
    operation("define", { tasks: array(task, 24, 2), reason }, ["tasks"]),
    operation("patch", { upsertTasks: array(taskPatch, 24, 1), removeTasks: array(taskId, 24, 1), reason }),
    operation("request_approval"),
    operation("start", { taskIds: array(taskId, 24, 1) }, ["taskIds"]),
    operation("done", { tasks: array(object({ id: taskId, evidence }, ["id", "evidence"]), 24, 1) }, ["tasks"]),
    operation("block", { tasks: array(object({ id: taskId, reason }, ["id", "reason"]), 24, 1) }, ["tasks"]),
    operation("reopen", { tasks: array(object({ id: taskId, reason }, ["id", "reason"]), 24, 1) }, ["tasks"]),
    operation("assess", { taskId, ...assessment }, ["taskId", "status", "evidence"]),
    operation("throw", { taskId, reason, evidence, sideEffects: string(800, { minLength: 1 }) }, ["taskId", "reason", "evidence"]),
    operation("cancel", { taskId, requestId: string(128, { minLength: 1, description: "Exact current attempt from the execution view." }) }, ["taskId", "requestId"]),
    operation("resolve", {
      requestId: string(128, { minLength: 1 }), confirmedNoActiveRuns: { type: "boolean", const: true },
      confirmationEvidence: string(600, { minLength: 12, description: "Observed native Subagent status proving all recorded child runs terminal; never assume unknown means stopped." }),
      results: array(object({ id: taskId, status: choice("done", "blocked"), evidence, reason }, ["id", "status"]), 6, 1),
    }, ["requestId", "confirmedNoActiveRuns", "confirmationEvidence", "results"]),
  ]),
  compass_acceptance: object({ results: array(object({ criterion, status: choice("reported_pass", "failed", "blocked", "inconclusive"), evidence: string(2000, { minLength: 1 }) }, ["criterion", "status", "evidence"]), 12, 1) }, ["results"]),
};
export const COMPASS_TOOL_NAMES = [...Object.keys(toolSchemas), "runtime_guard"];
