import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { piRoot } from "./register-pi-host-typebox.mjs";
import { contentVersion, pinnedContextOverlay, planContextBoundary, planWatchBoundary, restoreContextState, searchContext } from "../src/context-core.mjs";
import { buildStateSnapshot, emptyGoalRunState, observeHumanInput, setGoal } from "../src/goal-run.mjs";
const { SessionManager } = await import(new URL("dist/core/session-manager.js", pathToFileURL(`${piRoot}/`)));

const count = Number.parseInt(process.env.PI_COMPASS_MEASURE_MESSAGES ?? "1000", 10);
const manager = SessionManager.inMemory("/tmp/pi-compass-measure");
for (let i = 0; i < count; i += 1) manager.appendMessage({ role: "user", content: `measurement source ${i} stable retrieval phrase`, timestamp: Date.now() });
const branch = manager.getBranch();
const state = restoreContextState(branch);
const context = { contextMessages: manager.buildSessionProjection().messages };
const sample = (fn, rounds = 5) => {
  const times = [];
  let result;
  for (let i = 0; i < rounds; i += 1) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  return { result, medianMs: times.sort((a, b) => a - b)[Math.floor(times.length / 2)] };
};
const retrieval = sample(() => searchContext(branch, { context }, state, { query: "stable retrieval phrase", scope: "all", limit: 8 }));
const miss = sample(() => searchContext(branch, { context }, state, { query: "absent-query-for-bounded-scan", scope: "all", limit: 8 }));
const transition = sample(() => planWatchBoundary({
  state,
  boundary: { toolResults: [{ toolName: "watch", details: { id: "w-measure", status: "armed" }, content: [] }] },
}));
const contextBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
const frameWindow = Math.min(count, 128);
manager.appendCompaction("Synthetic parent summary for a bounded active window.", branch[count - frameWindow].id, 0, {}, true);
const operation = { action: "call", expectedRevision: 0, task: "Measure an empty-capture attention frame" };
const call = { role: "assistant", content: [{ type: "toolCall", id: "measure-frame", name: "compass_context", arguments: operation }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: 0 };
const reply = { role: "toolResult", toolCallId: "measure-frame", toolName: "compass_context", content: [], details: { contextOperation: operation }, isError: false, timestamp: 0 };
const messageEntryId = manager.appendMessage(call);
const replyEntryId = manager.appendMessage(reply);
const projection = manager.buildSessionProjection();
const frame = sample(() => planContextBoundary({ state, branch: manager.getBranch(), boundary: {
  type: "turn_end", outcome: "completed", message: call, messageEntryId,
  toolResults: [reply], toolResultEntryIds: [replyEntryId], entries: [],
  context: { contextEntries: projection.entries, contextMessages: projection.messages },
} }));
// A retained-head fixture references raw native content, never a copied body.
const retained = structuredClone(state);
const source = branch[0];
const key = `root/${source.id}`;
retained.values[key] = { entryId: source.id, field: "content", version: contentVersion(source.message.content), kind: "human", readOnly: true, rendered: false, handling: "active", caveats: [], sources: [source.id] };
retained.pins.push({ id: source.id, key, scope: "root" });
manager.appendCompaction("Synthetic native summary omitted a retained source.", null, 0, {}, true);
const compacted = manager.buildSessionProjection().messages;
const overlay = sample(() => pinnedContextOverlay(manager.getBranch(), retained, compacted, 1));
const nativeBytes = Buffer.byteLength(JSON.stringify(compacted), "utf8");
const outgoingBytes = Buffer.byteLength(JSON.stringify([...compacted, ...overlay.result]), "utf8");
const goalState = setGoal(observeHumanInput(emptyGoalRunState(), source.id).state, {
  expectedVersion: 0, current: "Measure bounded Compass context operations", sourceIds: [source.id], constraints: [],
}).state;
const goalRead = sample(() => buildStateSnapshot(goalState));
const unchangedRead = sample(() => buildStateSnapshot(goalState, goalRead.result.cursor));
const result = {
  schemaVersion: 1,
  goalStateRead: { medianMs: Number(goalRead.medianMs.toFixed(3)), bytes: Buffer.byteLength(JSON.stringify(goalRead.result), "utf8"), unchangedBytes: Buffer.byteLength(JSON.stringify(unchangedRead.result), "utf8") },
  messages: count,
  branchEntries: branch.length,
  retrieval: { medianMs: Number(retrieval.medianMs.toFixed(3)), hits: retrieval.result.hits.length, scanned: retrieval.result.scanned, truncated: retrieval.result.truncated },
  frameCall: { activeWindow: frameWindow, medianMs: Number(frame.medianMs.toFixed(3)), draftEdits: frame.result.entries.filter((entry) => entry.type === "context_edit").length, draftBytes: Buffer.byteLength(JSON.stringify(frame.result.entries), "utf8"), controlBytes: Buffer.byteLength(JSON.stringify(frame.result.state), "utf8") },
  retrievalMiss: { medianMs: Number(miss.medianMs.toFixed(3)), scanned: miss.result.scanned, truncated: miss.result.truncated },
  retainedOverlay: { medianMs: Number(overlay.medianMs.toFixed(3)), nativeBytes, outgoingBytes, addedBytes: outgoingBytes - nativeBytes },
  watchTransition: { medianMs: Number(transition.medianMs.toFixed(3)), changed: Boolean(transition.result), nextStateBytes: transition.result ? Buffer.byteLength(JSON.stringify(transition.result.state), "utf8") : stateBytes },
  bytes: { projectedContext: contextBytes, controlState: stateBytes },
  process: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
  caveat: "Local installed-Pi projection and synthetic messages; not provider latency, token, cache, or semantic-quality evidence.",
};
console.log(JSON.stringify(result, null, 2));
