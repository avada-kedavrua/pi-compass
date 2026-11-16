import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { piRoot } from "../scripts/register-pi-host-typebox.mjs";
import { contextSearchSchema, contextToolSchema } from "../src/context-tool-schema.mjs";
import { contextRef } from "../src/context-values.mjs";
const base = pathToFileURL(`${piRoot}/`);
const { validateToolArguments } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/utils/validation.js", base));
const { renderToolSignature } = await import(new URL("node_modules/@earendil-works/pi-codemode/dist/declarations.js", base));
const ref = contextRef({ binding: "root/source", version: "a".repeat(24) });
const validate = (schema, args) => validateToolArguments({ name: "compass_context", parameters: schema }, { name: "compass_context", arguments: args });

test("common contract accepts intent and refs, rejects internal plumbing and unopened operations", () => {
  const schema = contextToolSchema();
  for (const operation of [{ action: "pin", sources: [ref] }, { action: "remember", text: "Qualified conclusion", sources: [ref] }]) assert.deepEqual(validate(schema, { operation }), { operation });
  for (const operation of [{ action: "pin", ids: ["source"], binding: "root/source", expectedRevision: 0 }, { action: "pin", sources: [] }, { action: "call", task: "local" }]) assert.throws(() => validate(schema, { operation }));
  assert.deepEqual(validate(contextSearchSchema(), { view: "handles", refs: [ref] }), { view: "handles", refs: [ref] });
  assert.throws(() => validate(contextSearchSchema(), { ids: ["source"] }));
});

test("explicit advanced contract stays provider-safe and Code Mode-declarable", () => {
  const schema = contextToolSchema(true);
  const projected = { type: "object", properties: schema.properties, required: schema.required };
  const args = { operation: { action: "load", source: ref, range: { startLine: 2, endLine: 5 } } };
  assert.deepEqual(validate(projected, args), args);
  assert.throws(() => validate(projected, { operation: { action: "spill", source: ref } }));
  const signature = renderToolSignature({ name: "compass_context", inputSchema: schema });
  assert.doesNotMatch(signature, /args: unknown|operation: unknown|expectedRevision|binding|version:/);
  assert.ok(signature.length < 16000);
});
