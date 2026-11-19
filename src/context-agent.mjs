import { sourceIndex, searchContext, retentionForGoal, visiblePins } from "./context-core.mjs";
import { currentValue, contextRef, contextSelection } from "./context-values.mjs";
import { resolveSource } from "./context-retrieval.mjs";

export function agentSearch(branch, boundary, state, params = {}) {
  const { refs, view = "snippets", ...query } = params;
  if (!["snippets", "handles", "details"].includes(view)) throw new Error("view must be snippets, handles or details. No context changed.");
  let result;
  if (refs) {
    if (query.query) throw new Error("Use query to find sources or refs to recover exact selections, not both. No context changed.");
    const index = sourceIndex(branch, boundary);
    const limit = query.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("limit must be 1..16. No context changed.");
    const resolved = refs.map(contextSelection).map((item) => resolveSource(index, state, item, query.sourceScope ?? "all"));
    result = { frame: state.frames.at(-1)?.id ?? "root", truncated: resolved.length > limit, hits: resolved.slice(0, limit).map((item) => {
      const blocks = typeof item.content === "string" ? [{ type: "text", text: item.content }] : item.content;
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      return { ...item, snippet: text.slice(0, 600), truncated: text.length > 600, pinned: visiblePins(state).some((pin) => pin.key === item.binding) };
    }) };
  } else result = searchContext(branch, boundary, state, query);
  const hits = result.hits.map((hit) => {
    const item = { ref: contextRef(hit), type: hit.authorship };
    if (hit.readStatus?.path) item.path = hit.readStatus.path;
    if (hit.caveats.length) item.caveats = hit.caveats;
    if (hit.pinned) item.pinned = true;
    if (hit.visibility !== "active") item.omitted = true;
    if (view !== "handles") {
      item.text = hit.snippet.slice(0, view === "details" ? 600 : 180);
      if (hit.truncated || hit.snippet.length > item.text.length) item.excerpt = true;
    }
    if (view === "details") {
      if (hit.readStatus) item.read = { status: hit.readStatus.status, fileRange: hit.readStatus.range, exchangeComplete: hit.readStatus.exchangeComplete };
      if (hit.range) item.contentRange = hit.range;
      const origin = hit.head?.origin ?? hit.lineage;
      if (origin?.selections) item.from = origin.selections.map(contextRef);
      else if (origin?.ref) item.from = [origin.ref];
      if (hit.derived) item.derived = true;
    }
    return item;
  });
  return { frame: result.frame === "root" ? "main" : result.frame, hits, ...(result.truncated ? { incomplete: true } : {}) };
}

export function retainedContext(branch, boundary, state, goalVersion, limit) {
  const refs = [...new Set(visiblePins(retentionForGoal(state, goalVersion)).map((pin) => contextRef({ binding: pin.key, version: state.values[pin.key].version })))];
  const result = agentSearch(branch, boundary, state, { refs, limit: Math.min(limit, 16) });
  return { frame: result.frame, retained: result.hits, ...(result.incomplete ? { total: refs.length } : {}) };
}

/** Translate intent once. Agent never transports binding/version/revision tuples. */
export function agentContextOperation(branch, boundary, state, input) {
  const index = sourceIndex(branch, boundary);
  const selections = (input.sources ?? (input.source ? [input.source] : [])).map(contextSelection);
  if (new Set(selections.map((item) => item.id)).size !== selections.length) throw new Error("Select one value per logical source in a mutation. No context changed.");
  for (const item of selections) resolveSource(index, state, item, "all");
  const operation = { action: input.action, expectedRevision: state.revision, selections, ids: selections.map((item) => item.id) };
  if (selections.length === 1) Object.assign(operation, { binding: selections[0].binding, version: selections[0].version });
  operation.versions = selections.map(({ id, version }) => ({ id, version }));
  for (const name of ["task", "result", "range", "lifetime", "caveats", "handling", "reason", "path", "purpose", "watchIds"]) if (input[name] !== undefined) operation[name] = input[name];
  if (input.text !== undefined) operation.content = input.text;
  if (input.skill === true) operation.kind = "skill";
  if (input.capture) operation.capture = input.capture.map(({ ref, mode }) => ({ ...contextSelection(ref), mode }));
  if (input.exportSources) {
    operation.exportSelections = input.exportSources.map(contextSelection);
    operation.exportIds = operation.exportSelections.map((item) => item.id);
  }
  if (input.verifiedAgainst) operation.verifiedAgainst = contextSelection(input.verifiedAgainst);
  if (input.action === "transfer") {
    const frame = state.frames.at(-1);
    operation.watchScope = input.target === "root" ? "root" : frame?.parent;
  }
  // Protocol companions are deterministic, never another Agent bookkeeping task.
  if (input.action === "drop") {
    const companions = new Set(operation.ids);
    for (const item of selections) for (const id of index.groups.get(currentValue(state, index, item.id, { key: item.binding }).nativeId)?.ids ?? []) companions.add(id);
    const expected = new Map(operation.versions.map((item) => [item.id, item.version]));
    operation.versions = [...companions].map((id) => ({ id, version: expected.get(id) ?? currentValue(state, index, id).version }));
  }
  return operation;
}
