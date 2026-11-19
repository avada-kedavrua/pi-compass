import { contentVersion, contextRef } from "./context-values.mjs";

// Pi owns Human payloads. Latest-input review is independent of Goal approval.
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
