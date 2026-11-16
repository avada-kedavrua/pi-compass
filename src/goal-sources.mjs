import { contentVersion, contextRef, contextSelection } from "./context-values.mjs";

// Pi owns Human payloads. Goal provenance and latest-input review are separate.
export function latestHumanSource(branch) {
  if (!Array.isArray(branch)) throw new Error("Native active branch is unavailable. No state changed.");
  return branch.findLast((entry) => entry?.type === "message" && entry.message?.role === "user" && typeof entry.id === "string")?.id ?? null;
}
function humanRef(entry, id) {
  if (entry?.type !== "message" || entry.message?.role !== "user") throw new Error(`Goal source ${id} is unknown, wrong-branch, or not a native Human message. No state changed.`);
  return contextRef({ binding: `root/${id}`, version: contentVersion(entry.message.content) });
}
export function humanSourceRef(branch, id) {
  return humanRef(branch.find((entry) => entry.id === id), id);
}
export function resolveGoalSources(branch, refs) {
  if (!Array.isArray(refs) || !refs.length) throw new Error("Select the Human source refs that define the Goal. No state changed.");
  const entries = new Map(branch.map((entry) => [entry.id, entry]));
  return refs.map((ref) => {
    const { id } = contextSelection(ref);
    if (humanRef(entries.get(id), id) !== ref) throw new Error("Goal sources must be original Human inputs, not private copies or derived values. No state changed.");
    return id;
  });
}
export function agentGoalDetails(branch, details) {
  const { input, goal, criteria, humanAnswers } = details;
  const entries = new Map(branch.map((entry) => [entry.id, entry]));
  const ref = (id) => humanRef(entries.get(id), id);
  let semantic = null;
  if (goal) {
    const { sourceIds, originalSourceIds, original, current, ...text } = goal;
    semantic = { ...text, current, ...(original !== current ? { original } : {}), sources: sourceIds.map(ref) };
    if (JSON.stringify(sourceIds) !== JSON.stringify(originalSourceIds)) semantic.originalSources = originalSourceIds.map(ref);
  }
  return { goal: semantic, ...(input ? { input: { ref: ref(input.id), reviewed: input.reviewed } } : {}), ...(criteria.length ? { criteria } : {}), ...(humanAnswers.length ? { humanAnswers } : {}) };
}
