import { bindingKey, contentVersion, currentValue, logicalSource, rawMessage, snapshotHead, sourceQualifications, valueContent } from "./context-values.mjs";

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
function record(index, id, binding, origin, content, head = null, visibility = "omitted", projectionEditId = null) {
  const entry = index.byId.get(id);
  if (!readable(entry)) return null;
  const message = rawMessage(entry);
  const group = index.groups?.get(id);
  const exchangeComplete = Boolean(group && !group.duplicate && group.calls.size === group.results.size);
  const qualification = sourceQualifications(entry, index.readRequests?.get(id), exchangeComplete);
  const editId = head?.editId ?? projectionEditId;
  const authored = head?.field === "operation";
  const derived = authored || editId !== null || head?.field === "snapshot";
  const authorship = authored ? "agent-derived" : editId !== null ? "projection-derived" : head?.field === "snapshot" ? "retained-source-data" : message.role === "toolResult" ? "tool-observation" : message.role === "user" ? "human-original" : "agent-message";
  const caveats = [...new Set([...(qualification.caveats ?? []), ...(head?.caveats ?? [])])];
  return {
    id, binding, origin, content, head, visibility,
    version: head?.version ?? contentVersion(content),
    role: message.role, authorship, derived, editId,
    qualification: authored ? "Agent-authored derived value; not a new tool observation or Human instruction." : editId !== null ? "Native projection replacement; not original source content or evidence of a new execution or Human instruction." : head?.field === "snapshot" ? "Selected source data; not a new tool execution or Human message." : "Original source content.",
    ...(head?.readStatus ?? qualification.readStatus ? { readStatus: structuredClone(head?.readStatus ?? qualification.readStatus) } : {}),
    caveats,
    provenance: [...(head?.sources ?? [id])],
  };
}
function savedRecord(index, state, saved) {
  const id = saved.logicalId ?? logicalSource(index, saved.id);
  const binding = saved.binding ?? bindingKey(state, index, id);
  const head = saved.binding ? state.values[saved.binding] : null;
  // Ref writes deliberately change the current shared head; saved.valueState is
  // a return baseline, not a requirement that the parent value stay unchanged.
  if (head) return record(index, id, binding, "parent", valueContent(index, head, id), head);
  const entry = index.byId.get(saved.id);
  if (!readable(entry)) return null;
  const edit = saved.editId === null ? null : index.byId.get(saved.editId);
  if (saved.editId !== null && (edit?.type !== "context_edit" || edit.targetId !== saved.id || !edit.replacement)) fail(`Parent edit ${saved.editId} is unavailable.`);
  return record(index, id, binding, "parent", projected(entry, edit ? edit.replacement.content : rawMessage(entry).content), null, "omitted", edit?.id ?? null);
}
function* candidates(index, state, scope, ids) {
  const selected = (id) => !ids?.size || ids.has(id);
  if (scope === "active" || scope === "all") {
    const known = new Set();
    for (const key of Object.keys(state.values)) {
      const id = key.slice(key.indexOf("/") + 1);
      if (!selected(id)) continue;
      if (key !== bindingKey(state, index, id) && !state.pins?.some((pin) => pin.key === key) && !index.valueViews.has(key)) continue;
      const value = currentValue(state, index, id, { key, allowHidden: true });
      if (!value.message) continue;
      known.add(value.nativeId);
      yield record(index, id, key, "active", value.content, value.head, "active");
    }
    for (const [nativeId, item] of index.active) {
      if (!item.messages.length || known.has(nativeId)) continue;
      const id = logicalSource(index, nativeId);
      if (!selected(id)) continue;
      const value = currentValue(state, index, id, { allowHidden: true });
      if (value.nativeId !== nativeId) continue;
      yield record(index, id, value.key, "active", value.content, value.head, "active");
    }
  }
  if (scope === "parent" || scope === "all") {
    for (const frame of state.frames.toReversed()) for (const saved of frame.saved) {
      // These were visible in the parent before call hid them. Pre-existing
      // omissions remain historical, not silently promoted into parent input.
      if (saved.visible && selected(saved.logicalId ?? logicalSource(index, saved.id))) yield savedRecord(index, state, saved);
    }
  }
  if (scope === "history" || scope === "all") {
    const seenHeads = new Set();
    for (let position = index.branch.length - 1; position >= 0; position--) {
      const entry = index.branch[position];
      if (entry.type === "custom" && entry.customType === "pi-compass-v2.context" && entry.data.schemaVersion === state.schemaVersion) {
        for (const [key, head] of Object.entries(entry.data.values)) {
          const id = key.slice(key.indexOf("/") + 1);
          const identity = `${key}:${head.version}`;
          if (!selected(id) || seenHeads.has(identity)) continue;
          seenHeads.add(identity);
          yield record(index, id, key, "history", valueContent(index, head, id), head);
        }
      } else if (entry.type === "context_edit" && entry.replacement) {
        const source = index.byId.get(entry.targetId);
        if (readable(source)) {
          const id = logicalSource(index, entry.targetId);
          if (selected(id)) yield record(index, id, bindingKey(state, index, id), "history", projected(source, entry.replacement.content), null, "omitted", entry.id);
        }
      } else if (entry.customType === "pi-compass-v2.value" && entry.details?.derived) {
        const id = logicalSource(index, entry.id);
        if (!selected(id)) continue;
        const head = snapshotHead(entry);
        yield record(index, id, entry.details.key, "history", valueContent(index, head, id), head);
      } else if (readable(entry)) {
        const id = logicalSource(index, entry.id);
        // A value-view wrapper is an observation about a source, not a new raw
        // version of that source. Its immutable head is indexed above.
        if (id === entry.id && selected(id)) yield record(index, id, bindingKey(state, index, id), "history", projected(entry, rawMessage(entry).content));
      }
    }
  }
}
function scopes(scope) {
  if (!["active", "parent", "history", "all"].includes(scope)) fail("Unknown source scope.");
}
function* uniqueCandidates(index, state, scope, ids) {
  const seen = new Set();
  for (const candidate of candidates(index, state, scope, ids)) {
    if (!candidate) continue;
    const entry = index.byId.get(candidate.id);
    const group = index.groups?.get(candidate.id);
    const request = group && rawMessage(index.byId.get(group.ids[0]));
    const native = rawMessage(entry);
    const nested = native?.nestedCalls;
    const directSearch = native?.toolName === "compass_context_search" || native?.toolName === "compass_context" && request?.content?.some?.((part) => part.type === "toolCall" && part.name === "compass_context" && (part.arguments?.operation?.action ?? part.arguments?.action) === "search");
    const nestedSearch = native?.toolName === "codemode" && nested?.complete === true && nested.calls?.length > 0 && nested.calls.every((call) => call.name === "compass_context_search" || call.name === "compass_context" && (call.arguments?.operation?.action ?? call.arguments?.action) === "search");
    if (!ids?.size && (directSearch || nestedSearch)) continue;
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
export function searchSources(index, state, { query = "", ids = [], scope = "active", limit = 8, match = "any" } = {}) {
  scopes(scope);
  if (typeof query !== "string" || query.length > 400 || !Number.isInteger(limit) || limit < 1 || limit > 16) fail("Search requires query <=400 characters and limit 1..16.");
  if (!Array.isArray(ids) || ids.length > 256 || ids.some((id) => typeof id !== "string")) fail("Invalid source IDs.");
  if (!["any", "all"].includes(match)) fail("match must be any or all.");
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const hits = [];
  let scanned = 0;
  let truncated = false;
  let matches = 0;
  for (const candidate of uniqueCandidates(index, state, scope, new Set(ids))) {
    if (scanned === MAX_SCAN || (!terms.length && hits.length === limit)) { truncated = true; break; }
    scanned++;
    const parts = typeof candidate.content === "string" ? [{ type: "text", text: candidate.content }] : candidate.content;
    let part = -1;
    let matchedTerms = [];
    for (let index = 0; index < parts.length; index++) {
      if (parts[index].type !== "text") continue;
      const lower = parts[index].text.toLowerCase();
      const matched = terms.filter((term) => lower.includes(term));
      if (part < 0 || matched.length > matchedTerms.length) { part = index; matchedTerms = matched; }
    }
    if (terms.length && (match === "all" ? matchedTerms.length !== terms.length : !matchedTerms.length)) continue;
    matches++;
    const text = part < 0 ? "" : parts[part].text;
    const at = matchedTerms.length ? text.toLowerCase().indexOf(matchedTerms[0]) : 0;
    const from = Math.max(0, at - 80);
    const to = Math.min(text.length, from + 600);
    const startLine = text.slice(0, Math.max(0, at)).split("\n").length;
    const endLine = Math.min(text.split("\n").length, startLine + 8);
    hits.push({
      id: candidate.id, binding: candidate.binding, version: candidate.version, role: candidate.role, authorship: candidate.authorship, derived: candidate.derived, editId: candidate.editId, qualification: candidate.qualification, readStatus: candidate.readStatus, kind: candidate.head?.kind,
      visibility: candidate.visibility, origin: candidate.origin,
      range: part < 0 ? null : { part, startLine, endLine },
      snippet: text.slice(from, to), matchedTerms, chars: text.length,
      truncated: from > 0 || to < text.length, caveats: candidate.caveats, provenance: candidate.provenance,
    });
    hits.sort((left, right) => right.matchedTerms.length - left.matchedTerms.length);
    if (hits.length > limit) hits.pop();
  }
  return { method: "lexical", scope, query, match, hits, scanned, truncated: truncated || matches > limit };
}
function textOf(content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return blocks.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 8192);
}
function canonicalPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  // A lexical a/../b collapse is not a filesystem identity proof when a is a
  // symlink. Ambiguous paths remain recoverable, but never trigger relocation.
  if (input.includes("\\") || input.split("/").includes("..")) return null;
  const absolute = input.startsWith("/");
  const segments = input.split("/").filter((segment) => segment && segment !== ".");
  return `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : ".");
}
/** Identity/revision contradictions remain evidence even when the payload is not movable. */
export function readObservationIdentity(index, id) {
  const message = rawMessage(index.byId.get(id));
  const call = index.readRequests?.get(id);
  if (message?.role !== "toolResult" || message.toolName !== "read" || call?.name !== "read") return null;
  const path = canonicalPath(call.arguments?.path);
  if (!path || /(^|\/)SKILL\.md$/i.test(path) || /(^|\/)skills\//i.test(path)) return null;
  const revision = message.details?.fileRevision;
  return { path, revision: typeof revision === "string" && revision ? revision : null };
}
function readRequest(index, id) {
  const entry = index.byId.get(id);
  const message = rawMessage(entry);
  const call = index.readRequests?.get(id);
  const exchange = index.groups?.get(id);
  const identity = readObservationIdentity(index, id);
  if (!identity || !exchange || exchange.duplicate || exchange.calls.size !== exchange.results.size || message.isError !== false || message.details?.error || (message.details?.truncation && message.details.truncation.truncated !== false)) return null;
  const args = call.arguments ?? {};
  const { path, revision } = identity;
  const range = args.range && typeof args.range === "object" ? args.range : {};
  const startLine = range.startLine ?? args.startLine ?? args.offset ?? 1;
  const requestedEnd = range.endLine ?? args.endLine;
  const limit = range.limit ?? args.limit;
  if (!Number.isSafeInteger(startLine) || startLine < 1 || (requestedEnd !== undefined && (!Number.isSafeInteger(requestedEnd) || requestedEnd < startLine)) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) return null;
  const content = projected(entry, message.content);
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks) || !blocks.length || blocks.some((part) => part.type !== "text")) return null;
  const text = blocks.map((part) => part.text).join("\n");
  const lines = text.split("\n");
  const actualEnd = startLine + lines.length - 1;
  const endLine = requestedEnd ?? (limit === undefined ? actualEnd : Math.min(actualEnd, startLine + limit - 1));
  return {
    id, callId: message.toolCallId, path, startLine, endLine, lines,
    rangeKey: JSON.stringify({ startLine, requestedEnd: requestedEnd ?? null, limit: limit ?? null }),
    payloadVersion: contentVersion(content), revision,
  };
}

/** Recognize only successful, complete results from the native read tool; other tool results are not movable reads. */
export function readOnlyObservation(index, id) { return readRequest(index, id); }

/** Cross-call exact/subset findings use persisted read identity, never bare text equality. */
function selectedReadWindow(observation, range) {
  if (!range) return { startLine: observation.startLine, endLine: observation.endLine, lines: observation.lines };
  if ((range.part ?? 0) !== 0) return null;
  const startLine = range.startLine ?? 1;
  const endLine = range.endLine ?? observation.lines.length;
  if (startLine < 1 || endLine < startLine || endLine > observation.lines.length) return null;
  return {
    startLine: observation.startLine + startLine - 1,
    endLine: observation.startLine + endLine - 1,
    lines: observation.lines.slice(startLine - 1, endLine),
  };
}
function readWindowMap(window) {
  return new Map(window.lines.map((line, offset) => [window.startLine + offset, line]));
}
function matchingIntersection(left, right) {
  const startLine = Math.max(left.startLine, right.startLine);
  const endLine = Math.min(left.endLine, right.endLine);
  if (endLine < startLine) return null;
  const a = readWindowMap(left), b = readWindowMap(right);
  for (let line = startLine; line <= endLine; line++) if (!a.has(line) || !b.has(line) || a.get(line) !== b.get(line)) return { startLine, endLine, matches: false };
  return { startLine, endLine, matches: true };
}
function observedAt(index, state, selection, inputIndex, scope) {
  if (!selection || typeof selection !== "object") fail("Comparison selections require source IDs and versions.");
  const item = resolveSource(index, state, { ...selection, range: undefined }, scope);
  if (item.role !== "toolResult" || item.head?.kind === "skill") return null;
  const identity = readObservationIdentity(index, item.id);
  if (!identity) return null;
  const observation = readRequest(index, item.id);
  if (!observation || observation.payloadVersion !== contentVersion(item.content)) return { id: item.id, version: item.version, inputIndex, identity, observation: null, content: item.content };
  const selected = selection.range ? selectSourceRange(item.content, selection.range) : { content: item.content, range: null };
  const window = selectedReadWindow(observation, selected.range);
  if (!window) return null;
  return { id: item.id, version: item.version, inputIndex, identity, observation, window, content: selected.content };
}

/** Cross-call findings require persisted successful read calls and source/range identity. */
export function analyzeRepeatedSelections(index, state, selections, scope = "all") {
  scopes(scope);
  if (!Array.isArray(selections) || selections.length > 16) fail("Comparison requires at most 16 explicit source selections.");
  const resolved = selections.map((selection, inputIndex) => observedAt(index, state, selection, inputIndex, scope)).filter(Boolean);
  const exact = [];
  const subsets = [];
  const changed = [];
  const unknown = [];
  const similarities = [];
  for (let left = 0; left < resolved.length; left++) for (let right = left + 1; right < resolved.length; right++) {
    const a = resolved[left], b = resolved[right];
    if (a.id === b.id || (a.observation && b.observation && a.observation.callId === b.observation.callId)) continue;
    if (a.identity.path !== b.identity.path) {
      if (!a.observation || !b.observation) continue;
      const termsA = new Set(textOf(a.content).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
      const termsB = new Set(textOf(b.content).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
      let intersection = 0;
      for (const term of termsA) if (termsB.has(term)) intersection++;
      const score = termsA.size && termsB.size ? intersection / (termsA.size + termsB.size - intersection) : 0;
      if (score >= 0.35) similarities.push({ first: a.inputIndex, second: b.inputIndex, score: Number(score.toFixed(3)), advisory: "Different read source; lexical similarity is not source identity. No automatic edit or relocation." });
      continue;
    }
    const revisionChanged = a.identity.revision && b.identity.revision && a.identity.revision !== b.identity.revision;
    if (revisionChanged) {
      changed.push({ first: a.inputIndex, second: b.inputIndex, firstId: a.id, secondId: b.id, path: a.identity.path, reason: "Native file revision changed, including a non-relocatable read result." });
      continue;
    }
    if (!a.observation || !b.observation) {
      unknown.push({ first: a.inputIndex, second: b.inputIndex, firstId: a.id, secondId: b.id, path: a.identity.path, reason: "Read payload is failed, incomplete or projection-derived; it cannot establish a verified repeat." });
      continue;
    }
    const sameRange = a.window.startLine === b.window.startLine && a.window.endLine === b.window.endLine;
    const intersection = matchingIntersection(a.window, b.window);
    if (sameRange && !intersection?.matches) {
      changed.push({ first: a.inputIndex, second: b.inputIndex, firstId: a.id, secondId: b.id, path: a.observation.path, reason: "The same read range returned different payload lines." });
      continue;
    }
    const payloadsMatch = a.observation.payloadVersion === b.observation.payloadVersion;
    if (sameRange && payloadsMatch && a.observation.rangeKey === b.observation.rangeKey) {
      const prior = index.positions.get(a.id) <= index.positions.get(b.id) ? a : b;
      exact.push({ first: a.inputIndex, second: b.inputIndex, firstId: a.id, secondId: b.id, relocateId: prior.id, path: a.observation.path, range: { startLine: a.window.startLine, endLine: a.window.endLine }, payloadVersion: prior.observation.payloadVersion, changed: "Prior read can be relocated as qualified data; neither raw exchange is rewritten." });
      continue;
    }
    if (!intersection) continue;
    if (!intersection.matches) {
      changed.push({ first: a.inputIndex, second: b.inputIndex, firstId: a.id, secondId: b.id, path: a.observation.path, range: intersection, reason: "Overlapping line payloads differ; no subset relocation is safe." });
      continue;
    }
    const aContainsB = a.window.startLine <= b.window.startLine && a.window.endLine >= b.window.endLine;
    const bContainsA = b.window.startLine <= a.window.startLine && b.window.endLine >= a.window.endLine;
    if (!aContainsB && !bContainsA) continue;
    const superset = aContainsB ? a : b;
    const subset = aContainsB ? b : a;
    const sameRevision = superset.observation.revision && subset.observation.revision && superset.observation.revision === subset.observation.revision;
    if (!sameRevision) {
      unknown.push({ first: a.inputIndex, second: b.inputIndex, firstId: a.id, secondId: b.id, supersetId: superset.id, subsetId: subset.id, path: superset.observation.path, matchingLines: intersection, reason: "Native read results expose no shared file revision; equal line payloads do not establish a same-revision subset." });
      continue;
    }
    subsets.push({ first: a.inputIndex, second: b.inputIndex, firstId: a.id, secondId: b.id, supersetId: superset.id, subsetId: subset.id, relocateId: superset.id, path: superset.observation.path, range: { startLine: subset.window.startLine, endLine: subset.window.endLine }, matchingLines: intersection, unrefreshedSupersetOutsideRange: true, fileRevision: superset.observation.revision, changed: "Retain and relocate the complete prior superset; data outside the requested subset remains unrefreshed." });
  }
  const invalidatedByLaterChange = (finding) => {
    const pairIds = [finding.firstId, finding.secondId];
    const pairPosition = Math.max(...pairIds.map((id) => index.positions.get(id) ?? -1));
    return changed.some((item) => {
      const ids = [item.firstId, item.secondId];
      const shared = ids.find((id) => pairIds.includes(id));
      const newer = ids.find((id) => id !== shared);
      return shared !== undefined && newer !== undefined && (index.positions.get(newer) ?? -1) > pairPosition;
    });
  };
  return { exact: exact.filter((item) => !invalidatedByLaterChange(item)), subsets: subsets.filter((item) => !invalidatedByLaterChange(item)), changed, unknown, similarities, automaticEdits: 0 };
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
      selectedVersion: contentVersion(item.content), role: item.role, authorship: item.authorship, derived: item.derived, editId: item.editId, qualification: item.qualification, readStatus: item.readStatus, origin: item.origin,
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
