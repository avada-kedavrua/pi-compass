#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const expectedVersion = option("--expected", "0.84.0");
const settingsPath = path.resolve(option("--settings", path.join(os.homedir(), ".pi", "agent", "settings.json")));
const runtimePath = path.resolve(option("--runtime-config", path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json")));
const packagePath = path.resolve(option("--package", path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "package.json")));
const strict = args.includes("--strict");
const results = [];
const add = (level, label, detail) => results.push({ level, label, detail });
function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON root must be an object");
    return value;
  } catch (error) {
    add("FAIL", path.basename(file), `${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
function containsKey(value, key) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([name, child]) => name === key || containsKey(child, key));
}

const settings = readJson(settingsPath);
const runtime = readJson(runtimePath);
const manifest = readJson(packagePath);
if (settings) add("PASS", "Pi settings JSON", settingsPath);
if (runtime) add("PASS", "pi-subagents runtime config JSON", runtimePath);
if (manifest?.name === "pi-subagents" && manifest.version === expectedVersion) add("PASS", "Installed pi-subagents package", `pi-subagents@${manifest.version}`);
else if (manifest) add(strict ? "FAIL" : "WARN", "Installed pi-subagents package", `expected pi-subagents@${expectedVersion}; found ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}`);

if (settings) {
  const packageSpecs = Array.isArray(settings.packages) ? settings.packages.filter((item) => typeof item === "string" && /(?:^|[:/])pi-subagents(?:@|$)/.test(item)) : [];
  if (packageSpecs.length === 1 && packageSpecs[0] === `npm:pi-subagents@${expectedVersion}`) add("PASS", "Version pin", `exactly one npm:pi-subagents@${expectedVersion} entry`);
  else add("FAIL", "Version pin", `expected exactly one npm:pi-subagents@${expectedVersion}; found ${packageSpecs.join(", ") || "none"}`);

  const subagents = settings.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) add("FAIL", "Pi subagents settings", "settings.subagents is missing or invalid");
  else {
    if (containsKey(subagents.agentOverrides, "fallbackModels")) add("FAIL", "Removed fallbackModels field", "Remove fallbackModels from every subagents.agentOverrides entry");
    else add("PASS", "Removed fallbackModels field", "no fallbackModels keys under agentOverrides");

    const runtimeOnlyKeys = ["toolActivation", "disabledFeatures", "parallel", "globalConcurrencyLimit", "maxSubagentDepth", "maxSubagentSpawnsPerRun", "maxSubagentSpawnsPerSession", "scheduledRuns", "missions", "inlineToolDisplay", "toolDescriptionMode", "asyncByDefault", "timeoutMs"];
    const misplaced = runtimeOnlyKeys.filter((key) => Object.hasOwn(subagents, key));
    if (misplaced.length) add("FAIL", "Configuration surface separation", `runtime options must not be placed under settings.subagents: ${misplaced.join(", ")}`);
    else add("PASS", "Configuration surface separation", "Pi settings contain only settings-level pi-subagents options");

    const expectedToolAllowlist = {
      scout: ["read", "grep", "find", "ls"],
      delegate: ["read", "grep", "find", "ls"],
      reviewer: ["read", "grep", "find", "ls"],
      oracle: ["read", "grep", "find", "ls"],
      researcher: ["web_search", "web_fetch"],
      "evidence-auditor": ["web_search", "web_fetch"],
    };
    for (const [role, expectedTools] of Object.entries(expectedToolAllowlist)) {
      const actual = subagents.agentOverrides?.[role]?.tools;
      const ok = Array.isArray(actual) && actual.length === expectedTools.length && actual.every((tool, index) => tool === expectedTools[index]);
      add(ok ? "PASS" : "FAIL", `Read-only tool allowlist ${role}`, ok ? expectedTools.join(", ") : `expected exactly ${expectedTools.join(", ")}; found ${Array.isArray(actual) ? actual.join(", ") : "none"}`);
    }
    if (subagents.defaultModel === "cliproxyapi/gpt-6-luna" && subagents.defaultThinking === "high") add("PASS", "Default model policy", "cliproxyapi/gpt-6-luna / high");
    else add("FAIL", "Default model policy", `expected cliproxyapi/gpt-6-luna / high; found ${subagents.defaultModel ?? "unset"} / ${subagents.defaultThinking ?? "unset"}`);

    const scope = subagents.modelScope;
    if (scope?.strict === true && scope?.enforce === true) add("PASS", "Strict model scope", "modelScope.enforce=true and strict=true");
    else add("FAIL", "Strict model scope", "modelScope.enforce=true and strict=true are required");
    const allowed = new Set(scope?.allow ?? []);
    for (const model of [
      "cliproxyapi/gpt-5.6-luna", "cliproxyapi/gpt-5.6-sol", "cliproxyapi/gpt-5.6-terra",
      "cliproxyapi/gpt-6-astra", "cliproxyapi/gpt-6-luna", "cliproxyapi/gpt-6-sol",
      "cliproxyapi/gpt-6.1-sol", "cliproxyapi/gpt-6.1-terra", "jrt/deepseek-v4.1-flash",
    ]) add(allowed.has(model) ? "PASS" : "FAIL", `Allowed model ${model}`, allowed.has(model) ? "present in strict modelScope allowlist" : "missing from modelScope.allow");
    const expectedAgentModels = {
      scout: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
      researcher: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
      delegate: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
      worker: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
      reviewer: ["cliproxyapi/gpt-6.1-sol", "jrt/deepseek-v4.1-flash"],
      "evidence-auditor": ["cliproxyapi/gpt-6.1-sol", "jrt/deepseek-v4.1-flash"],
      oracle: ["cliproxyapi/gpt-6.1-sol", "jrt/deepseek-v4.1-flash"],
      developer: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
      coder: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
      implementer: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
      develop: ["cliproxyapi/gpt-6-luna", "jrt/deepseek-v4.1-flash"],
    };
    for (const [role, expectedModels] of Object.entries(expectedAgentModels)) {
      const actual = scope?.agents?.[role]?.allow;
      const ok = Array.isArray(actual) && actual.length === expectedModels.length && expectedModels.every((model) => actual.includes(model));
      add(ok ? "PASS" : "FAIL", `Per-agent model scope ${role}`, ok ? expectedModels.join(", ") : `expected exactly ${expectedModels.join(", ")}; found ${Array.isArray(actual) ? actual.join(", ") : "none"}`);
    }
  }
}

if (runtime) {
  const checks = [
    ["parallel policy", runtime.parallel?.maxTasks === 4 && runtime.parallel?.concurrency === 4, "parallel.maxTasks=4 and parallel.concurrency=4"],
    ["global concurrency limit", runtime.globalConcurrencyLimit === 4, "globalConcurrencyLimit=4"],
    ["Subagent nesting depth", runtime.maxSubagentDepth === 1, "maxSubagentDepth=1"],
    ["per-run spawn budget", runtime.maxSubagentSpawnsPerRun === 24, "maxSubagentSpawnsPerRun=24"],
    ["per-session spawn budget", runtime.maxSubagentSpawnsPerSession === 100, "maxSubagentSpawnsPerSession=100"],
    ["async workflow policy", runtime.asyncByDefault === false, "asyncByDefault=false; Compass uses foreground structured delegation"],
    ["scheduled runs disabled", runtime.scheduledRuns?.enabled === false, "scheduledRuns.enabled=false"],
    ["automatic missions disabled", runtime.missions?.enabled === false, "missions.enabled=false"],
    ["compact tool description", runtime.toolDescriptionMode === "compact", "toolDescriptionMode=compact"],
    ["summary inline result", runtime.inlineToolDisplay === "summary", "inlineToolDisplay=summary"],
    ["bounded run timeout", runtime.timeoutMs === 3600000, "timeoutMs=3600000"],
  ];
  for (const [label, ok, detail] of checks) add(ok ? "PASS" : "FAIL", label, detail);
  const unsupported = ["toolActivation", "disabledFeatures"].filter((key) => Object.hasOwn(runtime, key));
  if (unsupported.length) add("FAIL", "Unsupported runtime keys", `remove undocumented/unsupported keys: ${unsupported.join(", ")}`);
  else add("PASS", "Unsupported runtime keys", "no toolActivation or disabledFeatures keys");
}

for (const result of results) process.stdout.write(`${result.level} ${result.label} — ${result.detail}\n`);
const failed = results.some((item) => item.level === "FAIL");
const warned = results.some((item) => item.level === "WARN");
if (failed || (strict && warned)) process.exitCode = 1;
