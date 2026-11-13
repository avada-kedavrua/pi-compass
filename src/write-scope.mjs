import path from "node:path";

function normalizePath(value, cwd) {
  const input = String(value ?? "").trim().replace(/\\/g, "/");
  if (!input) return "";
  if (/^[a-z]:\//i.test(input)) return input.toLowerCase().replace(/\/{2,}/g, "/");
  return path.resolve(cwd || process.cwd(), input).replace(/\\/g, "/");
}

function globToRegExp(pattern) {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        output += "(?:.*/)?";
      } else output += ".*";
    } else if (char === "*") output += "[^/]*";
    else if (char === "?") output += "[^/]";
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  output += "$";
  return new RegExp(output);
}

export function writeScopeMatches(targetValue, scopeValue, cwd = process.cwd()) {
  const target = normalizePath(targetValue, cwd);
  const scopeText = String(scopeValue ?? "").trim().replace(/\\/g, "/");
  if (!target || !scopeText || scopeText.toLowerCase() === "read-only") return false;
  const scope = normalizePath(scopeText, cwd);
  if (!scope) return false;
  if (/[*?]/.test(scopeText)) return globToRegExp(scope).test(target);
  if (target === scope) return true;
  // A trailing slash explicitly declares a directory scope; an exact directory
  // scope also covers descendants when it is an existing/intentional path.
  const directoryScope = scopeText.endsWith("/") ? scope : `${scope}/`;
  return target.startsWith(directoryScope);
}

export function executionDriftReason({ tasks = [], target, cwd = process.cwd() }) {
  const activeWriters = tasks.filter((task) => task?.status === "in_progress"
    && String(task?.writeScope ?? "").trim().toLowerCase() !== "read-only"
    && task?.executor !== "subagent");
  if (!activeWriters.length) return "A path-based write was attempted while no writable DAG task was in progress.";
  const explicitScopes = activeWriters.map((task) => String(task?.writeScope ?? "").trim()).filter(Boolean);
  // An unscoped active writer is an explicit lack of path-boundary evidence, not
  // proof of a violation. Do not manufacture a false-positive scope mismatch.
  if (!explicitScopes.length) return "";
  if (activeWriters.some((task) => !String(task?.writeScope ?? "").trim())) return "";
  if (explicitScopes.some((scope) => writeScopeMatches(target, scope, cwd))) return "";
  return `Write target is outside every declared scope of active writer task(s): ${activeWriters.map((task) => task.id).join(", ")}.`;
}
