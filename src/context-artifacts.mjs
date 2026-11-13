import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { contentVersion } from "./context-values.mjs";

const FORMAT = "pi-compass-v2.context-artifact";
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function targetPath(projectRoot, relativePath, allowMissing = false) {
  const root = await realpath(projectRoot);
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) throw new Error("Artifact path must be project-root relative.");
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Artifact path may not contain dot, parent or empty segments.");
  let target = root;
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment);
    let stat;
    try { stat = await lstat(target); }
    catch (error) { if (allowMissing && index === segments.length - 1 && error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error("Artifact paths may not traverse symlinks.");
    if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error("Artifact path has the wrong file type.");
  }
  return { root, target };
}
function validateSelection({ source, binding, version, purpose, caveats, provenance, content, range }) {
  if (typeof source !== "string" || !source || typeof binding !== "string" || !binding || !/^[a-f0-9]{24}$/.test(version)) throw new Error("Artifact requires exact source/binding/version identity.");
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 1000) throw new Error("Artifact purpose must contain 1..1000 characters.");
  if (!Array.isArray(caveats) || caveats.length > 12 || caveats.some((item) => typeof item !== "string" || item.length > 600)) throw new Error("Invalid artifact caveats.");
  if (!Array.isArray(provenance) || provenance.length > 32 || provenance.some((item) => typeof item !== "string")) throw new Error("Invalid artifact provenance.");
  if (content === undefined || (!range && contentVersion(content) !== version)) throw new Error("Artifact content does not match the full source version.");
  if (range !== null && (!range || typeof range !== "object" || !Number.isInteger(range.part) || range.part < 0)) throw new Error("Invalid artifact range.");
}
async function verifiedRead(request, descriptor) {
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1) throw new Error("An immutable artifact digest and byte length are required.");
  const { root, target } = await targetPath(request.projectRoot, request.relativePath);
  if (descriptor.projectRoot !== root) throw new Error("Artifact belongs to a different project root.");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== descriptor.bytes) throw new Error("Artifact byte length changed.");
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw new Error("Artifact digest or byte length does not verify.");
  let envelope;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Artifact is not valid UTF-8 JSON."); }
  if (envelope?.format !== FORMAT || envelope.formatVersion !== 1 || !envelope.manifest) throw new Error("Unsupported artifact format.");
  const manifest = envelope.manifest;
  validateSelection({ ...manifest, content: envelope.content });
  if (contentVersion(envelope.content) !== manifest.contentVersion) throw new Error("Artifact payload version does not verify.");
  for (const key of ["source", "binding", "version", "purpose"]) if (request[key] !== undefined && manifest[key] !== request[key]) throw new Error(`Artifact ${key} does not match the requested value.`);
  if (request.range !== undefined && JSON.stringify(manifest.range) !== JSON.stringify(request.range)) throw new Error("Artifact range does not match the requested selection.");
  return { manifest, content: envelope.content, verified: true, path: request.relativePath };
}
export async function writeContextArtifact({ projectRoot, relativePath, source, binding, version, range = null, purpose, caveats = [], provenance = [], content }) {
  let created = false;
  try {
    const manifest = { source, binding, version, range, purpose, caveats: [...caveats], provenance: [...provenance], contentVersion: contentVersion(content) };
    validateSelection({ ...manifest, content });
    const { root, target } = await targetPath(projectRoot, relativePath, true);
    const bytes = Buffer.from(JSON.stringify({ format: FORMAT, formatVersion: 1, manifest, content }), "utf8");
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // The receipt covers the complete envelope, including caveats/provenance,
    // not just payload bytes whose metadata could otherwise be changed silently.
    const artifact = { path: relativePath, projectRoot: root, sha256: sha256(bytes), bytes: bytes.byteLength, ...manifest };
    const loaded = await verifiedRead({ projectRoot, relativePath, source, binding, version, range, purpose }, artifact);
    return { ok: true, artifact, content: loaded.content, contextChanged: false };
  } catch (error) {
    return { ok: false, error: error.message, contextChanged: false, possibleOrphan: created ? { path: relativePath, exists: true } : null };
  }
}
export async function loadContextArtifact({ projectRoot, relativePath, artifact, ...expected }) {
  if (!artifact || artifact.path !== relativePath) throw new Error("An exact artifact receipt is required; no history fallback was used.");
  return verifiedRead({ projectRoot, relativePath, ...expected }, artifact);
}
