import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import { contextSearchSchema, contextToolSchema, toolSchemas } from "../src/tool-schema.mjs";
import { contextRef } from "../src/context-values.mjs";

const base = pathToFileURL(`${piRoot}/`);
const { validateToolArguments } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/utils/validation.js", base));
const { renderToolSignature } = await import(new URL("node_modules/@earendil-works/pi-codemode/dist/declarations.js", base));
const ref = contextRef({ binding: "root/source", version: "a".repeat(24) });
const validate = (name, schema, args) => validateToolArguments({ name, parameters: schema }, { name, arguments: args });

test("the context schema accepts semantic intent and rejects internal plumbing", () => {
  const schema = contextToolSchema();
  for (const operation of [
    { action: "pin", sources: [ref] },
    { action: "remember", text: "Qualified conclusion", sources: [ref] },
    { action: "load", source: ref, range: { startLine: 2, endLine: 5 } },
    { action: "move", sources: [ref], verifiedAgainst: ref },
    { action: "spill", source: ref, path: "artifacts/source.txt", purpose: "Recover later without context cost" },
    { action: "transfer", watchIds: ["w1"], target: "root" },
  ]) assert.deepEqual(validate("compass_context", schema, operation), operation);
  for (const operation of [
    { action: "pin", ids: ["source"], binding: "root/source", expectedRevision: 0 },
    { action: "pin", sources: [] },
    { action: "call", task: "local", expectedRevision: 2 },
    { action: "load" },
  ]) assert.throws(() => validate("compass_context", schema, operation));
  assert.deepEqual(validate("compass_context_search", contextSearchSchema(), { view: "handles", refs: [ref] }), { view: "handles", refs: [ref] });
  assert.throws(() => validate("compass_context_search", contextSearchSchema(), { ids: ["source"] }));
});

test("every fixed tool schema is provider-safe and Code Mode-declarable", () => {
  const schemas = { ...toolSchemas };
  for (const [name, schema] of Object.entries(schemas)) {
    const signature = renderToolSignature({ name, inputSchema: schema });
    assert.doesNotMatch(signature, /args: unknown|expectedRevision|binding|version:/, `${name} must not leak internal plumbing into the model signature`);
    assert.ok(signature.length < 16000, `${name} signature must stay under the provider-safe Code Mode input limit`);
  }
});
