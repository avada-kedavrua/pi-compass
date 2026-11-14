import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";

const native = pathToFileURL(`${piRoot}/`);
const { DefaultPackageManager } = await import(new URL("dist/core/package-manager.js", native));
const { SettingsManager } = await import(new URL("dist/core/settings-manager.js", native));
const { loadSkills, formatSkillsForPrompt } = await import(new URL("dist/core/skills.js", native));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("installed Pi discovers one progressive Compass Skill when the package is loaded outside its checkout", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "compass-resources-"));
  try {
    const agentDir = path.join(cwd, "agent");
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });
    const resources = await manager.resolveExtensionSources([packageRoot], { temporary: true });
    const enabled = resources.skills.filter((resource) => resource.enabled);
    assert.equal(enabled.length, 1, "project-local .agents discovery must not conceal a missing package declaration");
    const loaded = loadSkills({ cwd, agentDir, skillPaths: enabled.map((resource) => resource.path), includeDefaults: false });
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0].name, "pi-compass");
    assert.equal(loaded.skills[0].filePath, path.join(packageRoot, ".agents/skills/pi-compass/SKILL.md"));
    const prompt = formatSkillsForPrompt(loaded.skills, "read");
    assert.match(prompt, /pi-compass/);
    assert.doesNotMatch(prompt, /## Ownership|## Default path/, "full Skill instructions load only on demand");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
