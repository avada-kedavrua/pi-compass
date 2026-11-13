import { createHash } from "node:crypto";
import { open, readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { contentVersion } from "./context-values.mjs";

const ARTIFACT_FORMAT = "pi-compass-v2.context-artifact";
const ARTIFACT_VERSION = 1;

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function safeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) throw new Error("Artifact path must be project-root relative.");
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Artifact path must not contain empty, dot, or parent segments.");
  return segments;
}
async function checkedTarget(projectRoot, relativePath, { allowMissing = false } = {}) {
  const root = await realpath(projectRoot);
  const segments = safeRelativePath(relativePath);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Artifact path may not traverse symlinks.");
      if (i < segments.length - 1 && !stat.isDirectory()) throw new Error("Artifact parent path is not a directory.");
      if (i === segments.length - 1 && !stat.isFile()) throw new Error("Artifact target is not a regular file.");
    } catch (error) {
      if (error.code !== "ENOENT" || !allowMissing) throw error;
      if (i < segments.length - 1) throw new Error("Artifact parent directory does not exist.");
    }
  }
  const resolved = path.resolve(root, ...segments);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Artifact path escapes the project root.");
  return { root, target: resolved };
}
function validateDescriptor({ source, binding, version, range, purpose, caveats, provenance, content }) {
  if (typeof source !== "string" || !source || typeof binding !== "string" || !binding) throw new Error("Artifact source and binding are required.");
  if (typeof version !== "string" || !/^[a-f0-9]{24}$/.test(version) || contentVersion(content) !== version) throw new Error("Artifact content does not match the exact source version.");
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 1000) throw new Error("Artifact purpose is required and bounded.");
  if (!Array.isArray(caveats) || caveats.length > 12 || caveats.some((item) => typeof item !== "string" || item.length > 600)) throw new Error("Artifact caveats must contain at most 12 bounded strings.");
  if (!Array.isArray(provenance) || provenance.length > 32 || provenance.some((item) => typeof item !== "string")) throw new Error("Artifact provenance must contain at most 32 source IDs.");
  if (range !== null && (typeof range !== "object" || Array.isArray(range))) throw new Error("Artifact range must be an object or null.");
}

/** Persist a version-bound artifact, then verify the exact file by reading it back. */
export async function writeContextArtifact({ projectRoot, relativePath, source, binding, version, range = null, purpose, caveats = [], provenance = [], content }) {
  let target;
  let created = false;
  try {
    validateDescriptor({ source, binding, version, range, purpose, caveats, provenance, content });
    ({ target } = await checkedTarget(projectRoot, relativePath, { allowMissing: true }));
    const contentBytes = Buffer.from(JSON.stringify(content), "utf8");
    const digest = sha256(contentBytes);
    const envelope = {
      format: ARTIFACT_FORMAT, formatVersion: ARTIFACT_VERSION,
      manifest: { source, binding, version, range, purpose, caveats: [...caveats], provenance: [...provenance], bytes: contentBytes.byteLength, sha256: digest },
      content,
    };
    const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
    const handle = await open(target, "wx", 0o600);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const loaded = await readVerified({ projectRoot, relativePath, expected: { source, binding, version, range, purpose }, expectedDigest: digest });
    return { ok: true, artifact: { path: relativePath, ...loaded.manifest }, content: loaded.content, contextChanged: false };
  } catch (error) {
    return { ok: false, error: error.message, contextChanged: false, possibleOrphan: created ? { path: relativePath, exists: true } : null };
  }
}

async function readVerified({ projectRoot, relativePath, expected, expectedDigest }) {
  const { target } = await checkedTarget(projectRoot, relativePath);
  const bytes = await readFile(target);
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Artifact is not valid UTF-8 JSON."); }
  if (envelope?.format !== ARTIFACT_FORMAT || envelope.formatVersion !== ARTIFACT_VERSION || !envelope.manifest) throw new Error("Artifact format is unsupported.");
  const manifest = envelope.manifest;
  const contentBytes = Buffer.from(JSON.stringify(envelope.content), "utf8");
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes !== contentBytes.byteLength || typeof manifest.sha256 !== "string" || sha256(contentBytes) !== manifest.sha256) throw new Error("Artifact content digest or byte length does not verify.");
  if (contentVersion(envelope.content) !== manifest.version) throw new Error("Artifact content does not match its manifest version.");
  for (const key of ["source", "binding", "version", "purpose"]) if (expected?.[key] !== undefined && manifest[key] !== expected[key]) throw new Error(`Artifact ${key} does not match the requested value.`);
  if (expected?.range !== undefined && JSON.stringify(manifest.range) !== JSON.stringify(expected.range)) throw new Error("Artifact range does not match the requested range.");
  if (expectedDigest !== undefined && manifest.sha256 !== expectedDigest) throw new Error("Artifact readback digest differs from the written content.");
  return { manifest, content: envelope.content };
}

/** Recover only a verified artifact; there is deliberately no history fallback. */
export async function loadContextArtifact({ projectRoot, relativePath, source, binding, version, range, purpose }) {
  const expected = { source, binding, version, range, purpose };
  const loaded = await readVerified({ projectRoot, relativePath, expected });
  return { ...loaded, path: relativePath, verified: true };
}
