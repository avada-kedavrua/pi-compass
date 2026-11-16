import { parentPort } from "node:worker_threads";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";

// Inline means this worker, never Pi's main thread. Every start has a fresh VM.
const sandbox = new InlineCodemodeSandbox({
  wasm: await loadQuickJSWasm(), tools: [], globals: [],
  memoryLimitBytes: 32 * 1024 * 1024, interruptBudget: 1000,
});
parentPort.on("message", async ({ id, checks }) => {
  try {
    const results = [];
    for (const { source, event, compileOnly } of checks) {
      const code = `const check = (${source});
if (typeof check !== "function") throw new Error("check must be a function expression");
${compileOnly ? 'return {verdict:"pass"};' : 'return await check(load("event"));'}`;
      const run = sandbox.start(code, {
        startedAt: 0, seed: 0, tools: [], globals: [], store: { event },
        onCall() { throw new Error("Guard checks have no tool capabilities"); },
      });
      const result = await run.result;
      if (!result.ok) { results.push({ verdict: "unknown", error: result.error.message.slice(0, 240) }); continue; }
      const value = result.value;
      if (result.output.length || Object.keys(result.storeWrites?.set ?? {}).length || result.storeWrites?.delete?.length
        || !value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["verdict", "reason"].includes(key))
        || !["pass", "violation", "unknown"].includes(value.verdict)
        || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 240))) {
        results.push({ verdict: "unknown", error: "Return {verdict: pass|violation|unknown, reason?: string<=240}; no output or store writes." });
      } else results.push({ verdict: value.verdict, ...(value.reason ? { reason: value.reason } : {}) });
    }
    parentPort.postMessage({ id, results });
  } catch (error) { parentPort.postMessage({ id, error: String(error.message).slice(0, 240) }); }
});
parentPort.postMessage({ ready: true });
