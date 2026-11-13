import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { piRoot } from "./register-pi-host-typebox.mjs";
import { planWatchBoundary, restoreContextState, searchContext } from "../src/context-core.mjs";
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
const transition = sample(() => planWatchBoundary({
  state,
  boundary: { toolResults: [{ toolName: "watch", details: { id: "w-measure", status: "armed" }, content: [] }] },
}));
const contextBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
const result = {
  schemaVersion: 1,
  messages: count,
  branchEntries: branch.length,
  retrieval: { medianMs: Number(retrieval.medianMs.toFixed(3)), hits: retrieval.result.hits.length, scanned: retrieval.result.scanned, truncated: retrieval.result.truncated },
  watchTransition: { medianMs: Number(transition.medianMs.toFixed(3)), changed: Boolean(transition.result), nextStateBytes: transition.result ? Buffer.byteLength(JSON.stringify(transition.result.state), "utf8") : stateBytes },
  bytes: { projectedContext: contextBytes, controlState: stateBytes },
  process: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
  caveat: "Local installed-Pi projection and synthetic messages; not provider latency, token, cache, or semantic-quality evidence.",
};
console.log(JSON.stringify(result, null, 2));
