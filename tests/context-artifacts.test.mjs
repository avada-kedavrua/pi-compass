import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rename, symlink, access, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { contentVersion } from "../src/context-values.mjs";
import { writeContextArtifact } from "../src/context-artifacts.mjs";

// Deterministic race at the actual file-open boundary, not a probabilistic loop.
test("an ancestor replaced by a symlink cannot redirect artifact creation", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compass-artifact-race-"));
  const inside = path.join(root, "project");
  const outside = path.join(root, "outside");
  await mkdir(inside);
  await mkdir(outside);
  await mkdir(path.join(inside, "artifacts"));
  const originalOpen = fs.promises.open;
  let swapped = false;
  t.mock.method(fs.promises, "open", async (file, flags, mode) => {
    if ((flags & fs.constants.O_CREAT) && !swapped) {
      swapped = true;
      await rename(path.join(inside, "artifacts"), path.join(inside, "held"));
      await symlink(outside, path.join(inside, "artifacts"), "dir");
    }
    return originalOpen(file, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    const content = "qualified source";
    const result = await writeContextArtifact({ projectRoot: inside, relativePath: "artifacts/source.json", source: "source", binding: "root/source", version: contentVersion(content), content, purpose: "retain source" });
    assert.equal(swapped, true);
    await assert.rejects(access(path.join(outside, "source.json")), { code: "ENOENT" });
    assert.equal(result.ok, false, "changed pathname must fail the subsequent readback");
    assert.deepEqual(result.possibleOrphan, { path: "artifacts/source.json", exists: true });
    await access(path.join(inside, "held", "source.json"));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("stable ancestor symlinks and non-relative artifact paths fail before creation", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compass-artifact-path-"));
  try {
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, "link"), "dir");
    const content = "source";
    const request = { projectRoot: root, source: "source", binding: "root/source", version: contentVersion(content), content, purpose: "retain source" };
    for (const relativePath of ["link/source.json", "../source.json", "/source.json"]) {
      const result = await writeContextArtifact({ ...request, relativePath });
      assert.equal(result.ok, false);
      assert.equal(result.possibleOrphan, null);
    }
    await assert.rejects(access(path.join(root, "outside", "source.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
