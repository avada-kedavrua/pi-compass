#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { RuntimeGuards } from "../src/runtime-guard.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-measure-"));
const entries = [];
const api = { appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); }, getAllTools() { return [{ name: "bash" }]; } };
const ctx = { cwd: dir, sessionManager: { getSessionId: () => "measurement", getBranch: () => entries } };
const guards = new RuntimeGuards(api, { profileDir: dir });
const sample = async (fn, count = 25) => {
  const times = [];
  for (let i = 0; i < count; i++) { const start = performance.now(); await fn(); times.push(performance.now() - start); }
  const sorted = times.slice(1).sort((a, b) => a - b);
  return { coldMs: +times[0].toFixed(3), medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3) };
};
try {
  guards.restore(ctx);
  const event = { toolName: "bash", toolCallId: "measurement", input: { command: "pwd" } };
  const rssBefore = process.memoryUsage().rss;
  const noRules = await sample(() => guards.check(event, ctx));
  const start = performance.now();
  const put = await guards.control({ action: "put", scope: "global", expectedRevision: 0, rule: {
    id: "bounded-fixture", tools: ["bash"], read: ["input.command"], effect: "block", hint: "Fixture only.",
    check: 'e=>({verdict:e.input.command==="blocked"?"violation":"pass"})',
  } }, ctx);
  const putMs = +(performance.now() - start).toFixed(3);
  const unmatched = await sample(() => guards.check({ ...event, toolName: "read" }, ctx));
  const pass = await sample(async () => { if (await guards.check(event, ctx)) throw new Error("Unexpected block"); });
  const blocked = await sample(async () => { if (!(await guards.check({ ...event, input: { command: "blocked" } }, ctx))?.block) throw new Error("Missing block"); });
  const read = await guards.control({ action: "get" }, ctx);
  console.log(JSON.stringify({ noRules, unmatched, pass, blocked, putMs, mutationBytes: Buffer.byteLength(JSON.stringify(put)), listingBytes: Buffer.byteLength(JSON.stringify(read)), unchangedBytes: Buffer.byteLength(JSON.stringify(await guards.control({ action: "get", cursor: read.cursor }, ctx))), rssBefore, rssAfter: process.memoryUsage().rss,
    caveat: "Actual guard kernel/SQLite/public sandbox, temporary profile and in-memory branch adapter; not live AgentSession/provider latency or attributed memory/token savings." }));
} finally { await guards.close(); fs.rmSync(dir, { recursive: true, force: true }); }
