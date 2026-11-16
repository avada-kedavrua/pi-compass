import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentVersion } from "../src/context-values.mjs";
import { resolveSource, searchSources } from "../src/context-retrieval.mjs";
import { loadContextArtifact, writeContextArtifact } from "../src/context-artifacts.mjs";

function fixture() {
  const parent = { id: "parent", type: "message", message: { role: "user", content: "raw original\nsecond line" } };
  const edit = { id: "edit", type: "context_edit", targetId: "parent", replacement: { content: "edited answer\nnext line" } };
  const current = { id: "current", type: "message", message: { role: "user", content: "visible current" } };
  const branch = [parent, edit, current];
  const active = new Map([["current", { sourceEntry: current, messages: [current.message] }]]);
  const index = { branch, byId: new Map(branch.map((entry) => [entry.id, entry])), positions: new Map(branch.map((entry, i) => [entry.id, i])), active, edits: new Map([["parent", edit]]), valueViews: new Map() };
  const state = { frames: [{ id: "frame", boundaryId: "parent", saved: [
    { id: "parent", editId: "edit", visible: true, binding: null, valueState: null, logicalId: "parent" },
    { id: "current", editId: null, visible: true, binding: null, valueState: null, logicalId: "current" },
  ], refs: [], copies: [] }], values: {} };
  return { index, state };
}

test("history filters IDs and deduplicates retained heads before reading repeated payloads", () => {
  const { index, state } = fixture();
  state.schemaVersion = 5;
  state.frames = [];
  index.active.clear();
  const reads = { selected: 0, unrelated: 0 };
  const values = {};
  for (const id of Object.keys(reads)) {
    const content = `${id}: ${"payload".repeat(100)}`;
    const entry = { id, type: "message", message: { role: "user", get content() { reads[id]++; return content; } } };
    index.branch.push(entry);
    values[`root/${id}`] = { entryId: id, field: "content", version: contentVersion(content), kind: "human", readOnly: true, rendered: false, handling: "active", caveats: [], sources: [id] };
  }
  for (let i = 0; i < 256; i++) index.branch.push({ id: `state-${i}`, type: "custom", customType: "pi-compass-v2.context", data: { schemaVersion: 5, values } });
  index.byId = new Map(index.branch.map((entry) => [entry.id, entry]));
  index.positions = new Map(index.branch.map((entry, i) => [entry.id, i]));
  const result = searchSources(index, state, { query: "absent", ids: ["selected"], scope: "history" });
  assert.equal(result.scanned, 1);
  assert.equal(reads.unrelated, 0, "unselected payloads must not be dereferenced");
  assert.ok(reads.selected <= 2, `dereferenced one retained payload ${reads.selected} times`);
});

test("keyword bags rank literal matches; strict all is explicit and result snippets are not duplicated", () => {
  const { index, state } = fixture();
  const found = searchSources(index, state, { query: "visible missing current", limit: 1 });
  assert.equal(found.hits[0].id, "current");
  assert.deepEqual(found.hits[0].matchedTerms, ["visible", "current"]);
  assert.equal(found.hits[0].excerpt, undefined);
  assert.equal(searchSources(index, state, { query: "visible missing current", match: "all" }).hits.length, 0);
});

test("completed search-only Code Mode results do not recursively rank themselves", () => {
  const { index, state } = fixture();
  const echo = { id: "search-echo", type: "message", message: { role: "toolResult", toolName: "codemode", content: [{ type: "text", text: "needle" }], nestedCalls: { complete: true, calls: [{ name: "compass_context", arguments: { action: "search" } }] } } };
  index.branch.push(echo); index.byId.set(echo.id, echo);
  assert.equal(searchSources(index, state, { scope: "history", query: "needle" }).hits.length, 0);
  assert.equal(searchSources(index, state, { scope: "history", ids: [echo.id], query: "needle" }).hits[0].id, echo.id, "explicit source lookup remains recoverable");
});

test("searchSources returns bounded lexical hits and resolves an exact line range", () => {
  const { index, state } = fixture();
  const found = searchSources(index, state, { query: "visible", scope: "active" });
  assert.equal(found.method, "lexical");
  assert.equal(found.hits[0].id, "current");
  assert.equal(found.hits[0].visibility, "active");
  const version = contentVersion("visible current");
  const result = resolveSource(index, state, { id: "current", version, range: { startLine: 1, endLine: 1 } });
  assert.equal(result.content, "visible current");
  assert.throws(() => resolveSource(index, state, { id: "current", version: "0".repeat(24) }), /stale/);
  assert.throws(() => resolveSource(index, state, { id: "current", version, range: { startLine: 2 } }), /out of bounds/);
});

test("parent retrieval uses the saved edit rather than the raw original", () => {
  const { index, state } = fixture();
  const found = searchSources(index, state, { query: "edited answer", scope: "parent" });
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].id, "parent");
  assert.equal(found.hits[0].origin, "parent");
  assert.equal(found.hits[0].authorship, "projection-derived");
  assert.equal(found.hits[0].derived, true);
  assert.match(found.hits[0].qualification, /not original source content/);
  assert.equal(searchSources(index, state, { query: "raw original", scope: "parent" }).hits.length, 0);
  assert.equal(searchSources(index, state, { query: "edited answer", scope: "history" }).hits.some((hit) => hit.id === "parent"), true);
  assert.equal(searchSources(index, state, { query: "raw original", scope: "history" }).hits.some((hit) => hit.id === "parent"), true, "raw immutable versions remain separately recoverable");
  const result = resolveSource(index, state, { id: "parent", version: contentVersion("edited answer\nnext line") }, "parent");
  assert.equal(result.content, "edited answer\nnext line");
});

test("context artifacts verify readback and reject tampering without history fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compass-artifact-"));
  try {
    await mkdir(path.join(root, "artifacts"));
    const content = [{ type: "text", text: "preserved text" }, { type: "image", data: "AA==", mimeType: "image/png" }];
    const request = { projectRoot: root, relativePath: "artifacts/source.json", source: "source-id", binding: "root/source-id", version: contentVersion(content), range: null, purpose: "retain evidence", caveats: ["partial"], provenance: ["source-id"], content };
    const written = await writeContextArtifact(request);
    assert.equal(written.ok, true);
    assert.equal(written.artifact.sha256.length, 64);
    const loaded = await loadContextArtifact({ ...request, artifact: written.artifact, content: undefined, caveats: undefined, provenance: undefined });
    assert.deepEqual(loaded.content, content);
    const file = path.join(root, "artifacts/source.json");
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.manifest.caveats = ["silently removed qualification"];
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(loadContextArtifact({ ...request, artifact: written.artifact }), /digest|byte length/);
    envelope.manifest.caveats = request.caveats;
    envelope.content[0].text = "tampered";
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(loadContextArtifact({ ...request, artifact: written.artifact, content: undefined, caveats: undefined, provenance: undefined }), /digest|byte length|version/);
    const duplicate = await writeContextArtifact(request);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.possibleOrphan, null);
    const escaped = await writeContextArtifact({ ...request, relativePath: "../outside.json" });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.contextChanged, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
