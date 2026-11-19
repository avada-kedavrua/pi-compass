#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTEXT_SCHEMA_VERSION } from "../src/context-core.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const targetRoot = path.resolve(process.argv.find((arg) => !arg.startsWith("-") && arg !== process.argv[0] && arg !== process.argv[1]) ?? process.cwd());
const requireCompass = process.argv.includes("--require-compass");
const staticOnly = process.argv.includes("--static-only");
const home = os.homedir();
const results = [];

function add(level, label, detail) {
  results.push({ level, label, detail });
}

function run(command, args, timeout = 10000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { ok: false, text: result.error.message, status: null };
  return {
    ok: result.status === 0,
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    status: result.status,
  };
}

function parseVersion(text) {
  const match = String(text).match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(actual, minimum) {
  if (!actual) return false;
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function walkPackageJson(root, maxDepth = 4) {
  const found = [];
  function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (["node_modules", ".git", "sessions", "cache", "logs"].includes(entry.name)) continue;
      const child = path.join(current, entry.name);
      const manifest = path.join(child, "package.json");
      if (fs.existsSync(manifest)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
          found.push({ name: parsed.name ?? "", dir: child, manifest });
        } catch { /* Ignore malformed unrelated package metadata. */ }
      }
      walk(child, depth + 1);
    }
  }
  if (fs.existsSync(root)) walk(root, 0);
  return found;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const manifestPath = path.join(packageRoot, "package.json");
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* reported below */ }
if (manifest?.pi?.extensions?.includes("./src/index.ts") && fs.existsSync(path.join(packageRoot, "src/index.ts"))) {
  add("PASS", "Compass package", `${manifest.name} declares ./src/index.ts`);
} else {
  add("FAIL", "Compass package", "package.json must declare pi.extensions=[\"./src/index.ts\"] and the entry file must exist");
}
let release = null;
try { release = JSON.parse(fs.readFileSync(path.join(packageRoot, "RELEASE-MANIFEST.json"), "utf8")); } catch { /* reported below */ }
const minimumPi = parseVersion(release?.minimumPiVersion);
if (release?.name === manifest?.name && release?.version === manifest?.version && release?.goalRunSchemaVersion === 10 && release?.contextSchemaVersion === CONTEXT_SCHEMA_VERSION && minimumPi) {
  add("PASS", "Release identity", `Package/manifest ${release.version}; GoalRun v${release.goalRunSchemaVersion}; context v${CONTEXT_SCHEMA_VERSION}; Pi minimum ${release.minimumPiVersion}`);
} else add("FAIL", "Release identity", "RELEASE-MANIFEST.json must match the package and current GoalRun/context schemas and declare a valid Pi minimum");
const goalRunPath = path.join(packageRoot, "src", "goal-run.mjs");
const toolSchemaPath = path.join(packageRoot, "src", "tool-schema.mjs");
const fixedToolNames = [
  "compass_goal", "compass_state", "compass_context_search", "compass_context",
  "compass_plan", "compass_acceptance", "runtime_guard",
];
try {
  const goalRun = await import(pathToFileURL(goalRunPath).href);
  const { COMPASS_TOOL_NAMES } = await import(pathToFileURL(toolSchemaPath).href);
  const registryMatches = COMPASS_TOOL_NAMES.length === fixedToolNames.length && fixedToolNames.every((name, index) => COMPASS_TOOL_NAMES[index] === name);
  if (goalRun.GOAL_RUN_API_VERSION !== 10 || goalRun.GOAL_RUN_RELEASE !== manifest?.version || !registryMatches) {
    add("FAIL", "GoalRun module contract", `Expected API v10 / release ${manifest?.version} / tools ${fixedToolNames.join(", ")}; module reports API ${String(goalRun.GOAL_RUN_API_VERSION)} / release ${String(goalRun.GOAL_RUN_RELEASE)} / tools ${COMPASS_TOOL_NAMES.join(", ")}`);
  } else {
    const observed = goalRun.observeHumanInput(goalRun.emptyGoalRunState(), "preflight-human").state;
    const initial = goalRun.setGoal(observed, { expectedVersion: 0, current: "Verify cursor mechanics", sourceIds: ["preflight-human"], constraints: [] }).state;
    const snapshot = goalRun.buildStateSnapshot(initial);
    const unchanged = goalRun.buildStateSnapshot(initial, snapshot.cursor);
    if (!/^R\d+-E\d+-C\d+$/.test(snapshot.cursor) || unchanged.unchanged !== true || JSON.stringify(unchanged).length > 220) {
      add("FAIL", "State cursor contract", "Composite cursor or compact unchanged response failed the GoalRun smoke test");
    } else {
      add("PASS", "State cursor contract", "Composite Goal/event/frame cursor and compact unchanged response work");
    }
    add("PASS", "GoalRun module contract", `API v${goalRun.GOAL_RUN_API_VERSION}, release ${goalRun.GOAL_RUN_RELEASE}; fixed ${fixedToolNames.length}-tool registry`);
  }
} catch (error) {
  add("FAIL", "GoalRun module contract", `Could not load ${goalRunPath}: ${error instanceof Error ? error.message : String(error)}`);
}
const typeboxManifestPath = path.join(packageRoot, "node_modules", "typebox", "package.json");
const hasTypeboxRuntimeDependency = Object.hasOwn(manifest?.dependencies ?? {}, "typebox");
if (manifest?.peerDependencies?.typebox === "*" && !hasTypeboxRuntimeDependency) {
  add("PASS", "Host dependency: typebox", 'Declared as peerDependencies["typebox"] = "*"');
} else {
  add("FAIL", "Host dependency: typebox", 'Pi-provided TypeBox must be declared only as peerDependencies["typebox"] = "*"; it must not appear in dependencies');
}
if (fs.existsSync(typeboxManifestPath)) {
  add("FAIL", "No package-local TypeBox copy", "Found node_modules/typebox; it can bypass Pi's host module mapping. Reinstall with npm ci --omit=peer --ignore-scripts.");
} else {
  add("PASS", "No package-local TypeBox copy", "Pi host module is used; no duplicate package-local TypeBox is present");
}
const entryPath = path.join(packageRoot, "src", "index.ts");
if (staticOnly) {
  add("INFO", "Extension entry import", "Skipped by --static-only; full preflight/npm test resolves TypeBox through the installed Pi host");
} else {
  const hostTypeboxLoader = path.join(packageRoot, "scripts", "register-pi-host-typebox.mjs");
  const entryCheck = run("node", ["--import", hostTypeboxLoader, "--experimental-strip-types", "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(entryPath).href)}).then((m) => { if (typeof m.default !== "function") process.exit(2); }).catch((e) => { console.error(e?.stack || e); process.exit(1); })`]);
  if (entryCheck.ok) add("PASS", "Extension entry import", "src/index.ts resolves TypeBox through Pi's host package and exports the extension factory");
  else add("FAIL", "Extension entry import", entryCheck.text || "Host-mapped extension entry import failed");
  const hostCheck = run(process.execPath, ["--test", path.join(packageRoot, "tests/runtime-guard-host.test.mjs")], 30000);
  if (hostCheck.ok) add("PASS", "Native extension runner", "Unpatched Pi loader, TUI approval/RPC refusal, context boundaries, Worker and temporary profile SQLite passed; no provider request");
  else add("FAIL", "Native extension runner", hostCheck.text || "Native extension smoke test failed");
}

if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
  add("FAIL", "Target project", `Directory does not exist: ${targetRoot}`);
} else {
  add("PASS", "Target project", targetRoot);
  if (isInside(packageRoot, targetRoot) || isInside(targetRoot, packageRoot)) {
    add("WARN", "Repository separation", "Compass V2 and target project overlap. Install from the V2 path into the separate application repo; do not copy V2 source into the app repo.");
  } else {
    add("PASS", "Repository separation", "Compass source and target project are separate paths");
  }
}

if (staticOnly) {
  add("INFO", "Pi CLI", "Skipped by --static-only; this does not establish live Pi compatibility");
} else {
  const piVersionResult = run("pi", ["--version"]);
  const piVersion = piVersionResult.ok ? parseVersion(piVersionResult.text) : null;
  if (!piVersionResult.ok) {
    add("FAIL", "Pi CLI", `Could not run pi --version. ${piVersionResult.text || "Is Pi on PATH?"}`);
  } else if (!piVersion) {
    add("WARN", "Pi version", `Could not parse version output: ${piVersionResult.text}`);
  } else if (minimumPi && atLeast(piVersion, minimumPi)) {
    add("PASS", "Pi version", `${piVersion.join(".")} (current context_with_system minimum: ${release.minimumPiVersion})`);
  } else {
    add("FAIL", "Pi version", `${piVersion.join(".")} does not meet the declared integration baseline`);
  }
}

try {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-codemode"));
  const dependency = JSON.parse(readText(path.resolve(path.dirname(entry), "../package.json")));
  if (dependency.version !== manifest?.dependencies?.["@earendil-works/pi-codemode"]) throw new Error("Runtime dependency version does not match package.json");
  add("PASS", "Runtime guard sandbox", `${dependency.name} ${dependency.version}; owned dependency, not a Pi loader alias`);
} catch (error) { add("FAIL", "Runtime guard sandbox", `${error.message}; run npm ci --ignore-scripts --omit=peer in the package checkout`); }

const nodeResult = run("node", ["--version"]);
const nodeVersion = nodeResult.ok ? parseVersion(nodeResult.text) : null;
const requiredNode = manifest?.engines?.node ?? "";
const minimumNode = parseVersion(requiredNode.replace(/^>=\s*/, ""));
if (!nodeResult.ok) add("FAIL", "Node.js", "Node.js is not available on PATH");
else if (nodeVersion && minimumNode && atLeast(nodeVersion, minimumNode)) add("PASS", "Node.js", `${nodeResult.text} (package minimum: ${requiredNode})`);
else add("FAIL", "Node.js", `${nodeResult.text}; requires a valid engines.node (${requiredNode}) for the runtime guard dependency`);

const npmResult = run("npm", ["--version"]);
const bunResult = run("bun", ["--version"]);
if (npmResult.ok) add("PASS", "Package manager", `npm ${npmResult.text}`);
else if (bunResult.ok) add("PASS", "Package manager", `bun ${bunResult.text}`);
else add("WARN", "Package manager", "Neither npm nor bun is on PATH; pi install may still work if Pi has a configured npmCommand");

const settingsPaths = [
  path.join(targetRoot, ".pi", "settings.json"),
  path.join(targetRoot, ".pi", "settings.jsonc"),
  path.join(home, ".pi", "agent", "settings.json"),
  path.join(home, ".pi", "agent", "settings.jsonc"),
];
const settingsText = settingsPaths.map(readText).join("\n");
const packageDirs = [
  path.join(home, ".pi", "agent", "extensions"),
  path.join(home, ".pi", "agent", "packages"),
  path.join(targetRoot, ".pi", "extensions"),
  path.join(targetRoot, ".pi", "packages"),
];
const installedPackages = packageDirs.flatMap((dir) => walkPackageJson(dir));
const packageNames = installedPackages.map((pkg) => `${pkg.name} ${pkg.dir}`).join("\n");
const configuredText = `${settingsText}\n${packageNames}`;

const dependencyChecks = [
  { label: "pi-subagents", pattern: /pi[-_ ]?subagents|subagent/i },
  { label: "ask-user-questions", pattern: /ask[-_ ]?user[-_ ]?questions|ask.*user.*question|ask.*question/i },
  { label: "codemode", pattern: /code[-_ ]?mode/i },
];
for (const dependency of dependencyChecks) {
  if (dependency.pattern.test(configuredText)) {
    add("PASS", `Dependency reference: ${dependency.label}`, "Found in Pi settings or an installed package directory (active availability is checked inside Pi)");
  } else {
    add("WARN", `Dependency reference: ${dependency.label}`, "Not found by filesystem scan; this is not definitive because Pi may expose a built-in or differently named tool");
  }
}

const compassConfigured = /pi-compass-v2/i.test(settingsText) || settingsText.includes(packageRoot);
if (compassConfigured) add("PASS", "Compass installation", "A Compass reference is present in Pi settings");
else if (requireCompass) add("FAIL", "Compass installation", "No Compass V2 reference found in target .pi/settings.json or global Pi settings");
else add("INFO", "Compass installation", "Not yet referenced in settings; run this script with --require-compass after pi install -l");

const failures = results.filter((item) => item.level === "FAIL").length;
console.log(`Pi Compass V2 v${manifest?.version ?? "unknown"} preflight${staticOnly ? " (static-only)" : ""}`);
console.log(`Package: ${packageRoot}`);
console.log(`Target:  ${targetRoot}`);
console.log("");
for (const result of results) {
  console.log(`${result.level.padEnd(4)} ${result.label}: ${result.detail}`);
}
console.log("");
if (failures > 0) {
  console.log(`Preflight found ${failures} blocking issue(s). Fix FAIL items before installing.`);
  process.exitCode = 1;
} else {
  console.log(staticOnly ? "Static preflight passed. Live Pi runtime compatibility remains unverified." : "Static preflight passed. Run /compass-preflight inside the live Pi session to verify the active tool registry.");
}
