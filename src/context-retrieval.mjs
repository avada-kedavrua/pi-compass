import { bindingKey, contentVersion, currentValue, logicalSource, rawMessage, snapshotHead, valueContent } from "./context-values.mjs";

const RESERVED = new Set(["pi-compass-v2.goalrun-state", "pi-compass-v2.goalrun-anchor", "pi-compass-v2.conventions"]);
const MAX_SCAN = 1024;
function fail(message) { throw new Error(`${message} No context changed.`); }
function readable(entry) {
  const message = rawMessage(entry);
  return message && ["user", "assistant", "toolResult", "custom"].includes(message.role) && !RESERVED.has(message.customType);
}
function projected(entry, content) {
  return typeof content === "string" && ["assistant", "toolResult"].includes(rawMessage(entry)?.role) ? [{ type: "text", text: content }] : content;
}
function record(index, id, binding, origin, content, head = null, visibility = "omitted") {
  const entry = index.byId.get(id);
  if (!readable(entry)) return null;
  return {
    id, binding, origin, content, head, visibility,
    version: head?.version ?? contentVersion(content),
    role: rawMessage(entry).role,
    caveats: [...(head?.caveats ?? (rawMessage(entry).isError ? ["Original tool execution failed; a context view is not evidence of a successful rerun."] : []))],
    provenance: [...(head?.sources ?? [id])],
  };
}
function savedRecord(index, state, saved) {
  const id = saved.logicalId ?? logicalSource(index, saved.id);
  const binding = saved.binding ?? bindingKey(state, index, id);
  const head = saved.binding ? state.values[saved.binding] : null;
  // Ref writes deliberately change the current shared head; saved.valueState is
  // a return baseline, not a requirement that the parent value stay unchanged.
  if (head) return record(index, id, binding, "parent", valueContent(index, head), head);
  const entry = index.byId.get(saved.id);
  if (!readable(entry)) return null;
  const edit = saved.editId === null ? null : index.byId.get(saved.editId);
  if (saved.editId !== null && (edit?.type !== "context_edit" || edit.targetId !== saved.id || !edit.replacement)) fail(`Parent edit ${saved.editId} is unavailable.`);
  return record(index, id, binding, "parent", projected(entry, edit ? edit.replacement.content : rawMessage(entry).content));
}
function* candidates(index, state, scope) {
  if (scope === "active" || scope === "all") {
    const known = new Set();
    for (const key of Object.keys(state.values)) {
      const id = key.slice(key.indexOf("/") + 1);
      if (key !== bindingKey(state, index, id) && !state.pins?.some((pin) => pin.key === key) && !index.valueViews.has(key)) continue;
      const value = currentValue(state, index, id, { key, allowHidden: true });
      if (!value.message) continue;
      known.add(value.nativeId);
      yield record(index, id, key, "active", value.content, value.head, "active");
    }
    for (const [nativeId, item] of index.active) {
      if (!item.messages.length || known.has(nativeId)) continue;
      const id = logicalSource(index, nativeId);
      const value = currentValue(state, index, id);
      if (value.nativeId !== nativeId) continue;
      yield record(index, id, value.key, "active", value.content, value.head, "active");
    }
  }
  if (scope === "parent" || scope === "all") {
    for (const frame of state.frames.toReversed()) for (const saved of frame.saved) {
      // These were visible in the parent before call hid them. Pre-existing
      // omissions remain historical, not silently promoted into parent input.
      if (saved.visible) yield savedRecord(index, state, saved);
    }
  }
  if (scope === "history" || scope === "all") {
    for (const entry of index.branch.toReversed()) {
      if (entry.type === "custom" && entry.customType === "pi-compass-v2.context" && entry.data.schemaVersion === state.schemaVersion) {
        for (const [key, head] of Object.entries(entry.data.values)) {
          const id = key.slice(key.indexOf("/") + 1);
          yield record(index, id, key, "history", valueContent(index, head), head);
        }
      } else if (entry.type === "context_edit" && entry.replacement) {
        const source = index.byId.get(entry.targetId);
        if (readable(source)) {
          const id = logicalSource(index, entry.targetId);
          yield record(index, id, bindingKey(state, index, id), "history", projected(source, entry.replacement.content));
        }
      } else if (entry.customType === "pi-compass-v2.value" && entry.details?.derived) {
        const id = logicalSource(index, entry.id);
        const head = snapshotHead(entry);
        yield record(index, id, entry.details.key, "history", valueContent(index, head), head);
      } else if (readable(entry)) {
        const id = logicalSource(index, entry.id);
        // A value-view wrapper is an observation about a source, not a new raw
        // version of that source. Its immutable head is indexed above.
        if (id === entry.id) yield record(index, id, bindingKey(state, index, id), "history", projected(entry, rawMessage(entry).content));
      }
    }
  }
}
function scopes(scope) {
  if (!["active", "parent", "history", "all"].includes(scope)) fail("Unknown source scope.");
}
function* uniqueCandidates(index, state, scope, ids) {
  const seen = new Set();
  for (const candidate of candidates(index, state, scope)) {
    if (!candidate || (ids?.size && !ids.has(candidate.id))) continue;
    const key = `${candidate.binding}:${candidate.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    yield candidate;
  }
}
export function selectSourceRange(content, range) {
  if (!range) return { content: structuredClone(content), range: null };
  const part = range.part ?? 0;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Number.isInteger(part) || part < 0 || !Array.isArray(blocks) || part >= blocks.length) fail("Range part is out of bounds.");
  const block = blocks[part];
  if (range.startLine === undefined && range.endLine === undefined && block.type === "image") return { content: [structuredClone(block)], range: { part } };
  if (block.type !== "text") fail("Only text parts can be line-sliced; select an image part without line bounds.");
  const lines = block.text.split("\n");
  const startLine = range.startLine ?? 1;
  const endLine = range.endLine ?? lines.length;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) fail("Requested line range is stale or out of bounds.");
  const text = lines.slice(startLine - 1, endLine).join("\n");
  return { content: typeof content === "string" ? text : [{ ...block, text }], range: { part, startLine, endLine } };
}
export function searchSources(index, state, { query = "", ids = [], scope = "active", limit = 8 } = {}) {
  scopes(scope);
  if (typeof query !== "string" || query.length > 400 || !Number.isInteger(limit) || limit < 1 || limit > 16) fail("Search requires query <=400 characters and limit 1..16.");
  if (!Array.isArray(ids) || ids.length > 256 || ids.some((id) => typeof id !== "string")) fail("Invalid source IDs.");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  let scanned = 0;
  let truncated = false;
  for (const candidate of uniqueCandidates(index, state, scope, new Set(ids))) {
    if (scanned === MAX_SCAN || hits.length === limit) { truncated = true; break; }
    scanned++;
    const parts = typeof candidate.content === "string" ? [{ type: "text", text: candidate.content }] : candidate.content;
    const part = parts.findIndex((block) => block.type === "text" && terms.every((term) => block.text.toLowerCase().includes(term)));
    if (part < 0 && terms.length) continue;
    const text = part < 0 ? "" : parts[part].text;
    const at = terms.length ? text.toLowerCase().indexOf(terms[0]) : 0;
    const from = Math.max(0, at - 80);
    const to = Math.min(text.length, from + 600);
    const startLine = text.slice(0, Math.max(0, at)).split("\n").length;
    const endLine = Math.min(text.split("\n").length, startLine + 8);
    hits.push({
      id: candidate.id, binding: candidate.binding, version: candidate.version, role: candidate.role, kind: candidate.head?.kind,
      visibility: candidate.visibility, origin: candidate.origin,
      range: part < 0 ? null : { part, startLine, endLine },
      snippet: text.slice(from, to), excerpt: text.slice(from, to), chars: text.length,
      truncated: from > 0 || to < text.length, caveats: candidate.caveats, provenance: candidate.provenance,
    });
  }
  return { method: "lexical", scope, query, hits, scanned, truncated };
}
function rangeBounds(range) {
  if (!range) return null;
  return { part: range.part ?? 0, startLine: range.startLine ?? 1, endLine: range.endLine ?? Number.MAX_SAFE_INTEGER };
}
function sameRange(left, right) {
  return JSON.stringify(rangeBounds(left)) === JSON.stringify(rangeBounds(right));
}
function containsRange(outer, inner) {
  if (!outer) return true;
  if (!inner) return false;
  const a = rangeBounds(outer), b = rangeBounds(inner);
  return a.part === b.part && a.startLine <= b.startLine && a.endLine >= b.endLine;
}
function textOf(content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return blocks.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 8192);
}

/** Exact/subset findings require the same immutable source identity and version. Similarity is advisory only. */
export function analyzeRepeatedSelections(index, state, selections, scope = "all") {
  scopes(scope);
  if (!Array.isArray(selections) || selections.length > 16) fail("Comparison requires at most 16 explicit source selections.");
  const resolved = selections.map((selection) => {
    if (!selection || typeof selection !== "object") fail("Comparison selections require source IDs and versions.");
    const item = resolveSource(index, state, selection, scope);
    if (item.role === "user" || (item.role !== "toolResult" && !item.head?.readOnly)) return null;
    return { id: item.id, binding: item.binding, version: item.version, range: item.range, content: item.content, role: item.role };
  }).filter(Boolean);
  const exact = [];
  const subsets = [];
  const similarities = [];
  for (let left = 0; left < resolved.length; left++) for (let right = left + 1; right < resolved.length; right++) {
    const a = resolved[left], b = resolved[right];
    if (a.id === b.id && a.version === b.version) {
      if (sameRange(a.range, b.range)) exact.push({ source: a.id, version: a.version, first: left, second: right, range: a.range });
      else if (containsRange(a.range, b.range)) subsets.push({ source: a.id, version: a.version, superset: left, subset: right, supersetRange: a.range, subsetRange: b.range });
      else if (containsRange(b.range, a.range)) subsets.push({ source: a.id, version: a.version, superset: right, subset: left, supersetRange: b.range, subsetRange: a.range });
      continue;
    }
    const termsA = new Set(textOf(a.content).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
    const termsB = new Set(textOf(b.content).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
    if (!termsA.size || !termsB.size) continue;
    let intersection = 0;
    for (const term of termsA) if (termsB.has(term)) intersection++;
    const score = intersection / (termsA.size + termsB.size - intersection);
    if (score >= 0.35) similarities.push({ first: left, second: right, score: Number(score.toFixed(3)), advisory: "Different source identity; inspect before acting. No automatic edit or relocation." });
  }
  return { exact, subsets, similarities, automaticEdits: 0 };
}

/** Preserve the Agent's bounded semantic ordering while verifying each native source and requested range. */
export function rankVerifiedSources(index, state, selections, scope = "all") {
  scopes(scope);
  if (!Array.isArray(selections) || selections.length > 16 || new Set(selections.map((item) => item?.id)).size !== selections.length) fail("Ranked retrieval requires at most 16 unique source selections.");
  const sources = selections.map((selection, rank) => {
    const item = resolveSource(index, state, selection, scope);
    const blocks = typeof item.content === "string" ? [{ type: "text", text: item.content }] : item.content;
    const text = blocks.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return {
      rank, id: item.id, binding: item.binding, version: item.version, range: item.range,
      selectedVersion: contentVersion(item.content), role: item.role, origin: item.origin,
      snippet: text.slice(0, 600), truncated: text.length > 600,
      selectedParts: blocks.map((part, partIndex) => ({ part: partIndex, type: part.type, ...(part.type === "image" ? { mimeType: part.mimeType } : {}) })),
      caveats: item.caveats, provenance: item.provenance,
    };
  });
  return { method: "agent-selected-verified", ranking: "caller-order; not a runtime semantic score", sources };
}

export function resolveSource(index, state, { id, binding, version, range } = {}, scope = "all") {
  scopes(scope);
  if (typeof id !== "string" || !index.byId.has(id)) fail(`Unknown or wrong-branch source ${id}.`);
  if (typeof version !== "string" || !/^[a-f0-9]{24}$/.test(version)) fail("Resolve requires an exact source version.");
  const logicalId = logicalSource(index, id);
  let found = false;
  for (const candidate of uniqueCandidates(index, state, scope, new Set([logicalId]))) {
    found = true;
    if (candidate.version !== version || (binding !== undefined && candidate.binding !== binding)) continue;
    return { ...candidate, ...selectSourceRange(candidate.content, range), truncated: false };
  }
  fail(found ? `Source ${id} version or binding is stale or unavailable.` : `Source ${id} is not recoverable in scope ${scope}.`);
}
