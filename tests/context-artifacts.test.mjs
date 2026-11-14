import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rename, symlink, access, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { contentVersion } from "../src/context-values.mjs";
import { loadContextArtifact, writeContextArtifact } from "../src/context-artifacts.mjs";

test("artifact growth after stat cannot exceed the receipt-sized read budget", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compass-artifact-growth-"));
  let consumed = 0;
  try {
    const content = "bounded source";
    const request = { projectRoot: root, relativePath: "source.json", source: "source", binding: "root/source", version: contentVersion(content), content, purpose: "retain source" };
    const written = await writeContextArtifact(request);
    assert.equal(written.ok, true);
    const originalOpen = fs.promises.open;
    t.mock.method(fs.promises, "open", async (...args) => {
      const handle = await originalOpen(...args);
      if (!(args[1] & fs.constants.O_DIRECTORY)) {
        const stat = handle.stat.bind(handle);
        handle.stat = async () => {
          const observed = await stat();
          await fs.promises.appendFile(path.join(root, "source.json"), "x".repeat(128 * 1024));
          return observed;
        };
        for (const name of ["read", "readFile"]) {
          const read = handle[name].bind(handle);
          handle[name] = async (...input) => {
            const result = await read(...input);
            consumed += result.bytesRead ?? result.byteLength;
            return result;
          };
        }
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(loadContextArtifact({ ...request, artifact: written.artifact }), /byte length|digest/);
    assert.ok(consumed <= written.artifact.bytes + 1, `read ${consumed} bytes for a ${written.artifact.bytes}-byte receipt`);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

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
