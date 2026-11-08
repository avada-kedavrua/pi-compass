import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLiveAcceptanceFixture } from "../src/live-acceptance-root.mjs";

function makeProject(root, { name = "fixture", version = "1.0.0", readme = "# Fixture Project\n" } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(root, "README.md"), readme);
  fs.writeFileSync(path.join(root, "alpha.txt"), "safe fixture\n");
}

test("live acceptance uses the current project when its fixture files are present", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-live-root-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  makeProject(path.join(dir, "project"));
  const result = resolveLiveAcceptanceFixture({ cwd: path.join(dir, "project"), compassRoot: dir });
  assert.equal(result.root, path.join(dir, "project"));
  assert.equal(result.packageMeta.name, "fixture");
  assert.equal(result.readmeHeading, "Fixture Project");
  assert.equal(result.usedFallback, false);
  assert.deepEqual(result.rootEntries, ["README.md", "alpha.txt", "package.json"]);
});

test("live acceptance falls back to the Compass package root when the current project has no package fixture", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-live-root-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "application");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "notes.txt"), "no package metadata");
  const compassRoot = path.join(dir, "compass");
  makeProject(compassRoot, { name: "pi-compass-v2", version: "0.9.1", readme: "# Pi Compass V2\n" });
  const result = resolveLiveAcceptanceFixture({ cwd, compassRoot });
  assert.equal(result.root, compassRoot);
  assert.equal(result.packageMeta.name, "pi-compass-v2");
  assert.equal(result.usedFallback, true);
});

test("an explicit live acceptance root is authoritative and does not silently fall back", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compass-live-root-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "application");
  fs.mkdirSync(cwd);
  const target = path.join(dir, "target");
  makeProject(target, { name: "target-app" });
  const result = resolveLiveAcceptanceFixture({ args: target, cwd, compassRoot: target });
  assert.equal(result.root, target);
  assert.equal(result.usedFallback, false);
  assert.equal(result.explicit, true);
  assert.equal(resolveLiveAcceptanceFixture({ args: path.join(dir, "missing"), cwd, compassRoot: target }), null);
});
