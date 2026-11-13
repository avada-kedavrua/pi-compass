#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(p.version)' "$ROOT/package.json")"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="${PI_COMPASS_SETTINGS:-$AGENT_DIR/settings.json}"
SUBAGENTS_CONFIG="${PI_COMPASS_SUBAGENTS_CONFIG:-$AGENT_DIR/extensions/subagent/config.json}"
SUBAGENTS_ROOT="${PI_SUBAGENTS_ROOT:-$AGENT_DIR/npm/node_modules/pi-subagents}"
OUT="${PI_COMPASS_EVIDENCE_DIR:-/tmp/pi-compass-live-evidence-$(date -u +%Y%m%dT%H%M%SZ)}"
TMP_AGENT=""
PI_PID=""

cleanup() {
  if [[ -n "$PI_PID" ]] && kill -0 "$PI_PID" 2>/dev/null; then
    kill "$PI_PID" 2>/dev/null || true
    wait "$PI_PID" 2>/dev/null || true
  fi
  if [[ -n "$TMP_AGENT" && -d "$TMP_AGENT" ]]; then
    rm -rf -- "$TMP_AGENT"
  fi
}
trap cleanup EXIT INT TERM

fail() { printf 'BLOCKED: %s\n' "$*" >&2; exit 2; }

[[ -f "$ROOT/package.json" && -f "$ROOT/src/index.ts" ]] || fail "Run this script from the extracted Pi Compass $RELEASE package (script is expected under its scripts/ directory)."
[[ -f "$SETTINGS" ]] || fail "Pi settings not found at $SETTINGS. Set PI_COMPASS_SETTINGS to the actual settings.json path."
[[ -d "$SUBAGENTS_ROOT" && -f "$SUBAGENTS_ROOT/package.json" ]] || fail "pi-subagents package not found at $SUBAGENTS_ROOT. Set PI_SUBAGENTS_ROOT if installed elsewhere."
command -v node >/dev/null 2>&1 || fail "Node.js is not on PATH."
command -v npm >/dev/null 2>&1 || fail "npm is not on PATH."
command -v pi >/dev/null 2>&1 || fail "Pi CLI is not on PATH."
command -v tar >/dev/null 2>&1 || fail "tar is required to package the evidence bundle."

[[ "$OUT" == /tmp/pi-compass-live-evidence-* ]] || fail "PI_COMPASS_EVIDENCE_DIR must use a private /tmp/pi-compass-live-evidence-* directory so the report path is safe and predictable."
[[ ! -e "$OUT" ]] || fail "Evidence directory already exists: $OUT. Choose a fresh PI_COMPASS_EVIDENCE_DIR; existing evidence will not be overwritten."
mkdir -p "$OUT"
chmod 700 "$OUT"
TMP_AGENT="$(mktemp -d /tmp/pi-compass-agent.XXXXXX)"
chmod 700 "$TMP_AGENT"
mkdir -p "$TMP_AGENT/sessions"
chmod 700 "$TMP_AGENT/sessions"

node --version > "$OUT/node-version.txt" 2>&1
npm --version > "$OUT/npm-version.txt" 2>&1
pi --version > "$OUT/pi-version.txt" 2>&1 || true
if PI_COMPASS_ROOT="$ROOT" node --input-type=module - "$OUT/pi-version.txt" > "$OUT/pi-version-check.txt" 2>&1 <<'NODE'
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
if (!match) { console.error(`Cannot parse Pi version from: ${text.trim() || "empty output"}`); process.exit(1); }
const version = match.slice(1).map(Number);
const manifest = JSON.parse(fs.readFileSync(`${process.env.PI_COMPASS_ROOT}/RELEASE-MANIFEST.json`, 'utf8'));
const minimum = manifest.minimumPiVersion.split('.').map(Number);
const ok = version[0] > minimum[0] || (version[0] === minimum[0] && (version[1] > minimum[1] || (version[1] === minimum[1] && version[2] >= minimum[2])));
console.log(`Detected Pi ${version.join(".")}; minimum required: ${manifest.minimumPiVersion}; ${ok ? "PASS" : "FAIL"}`);
if (!ok) process.exit(1);
NODE
then PI_VERSION_RC=0; else PI_VERSION_RC=$?; fi
node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(`${p.name}@${p.version}\n`)' "$SUBAGENTS_ROOT/package.json" > "$OUT/pi-subagents-version.txt"

# Pi provides TypeBox. A package-local copy can bypass the host module map.
if [[ -f "$ROOT/node_modules/typebox/package.json" ]]; then
  printf 'BLOCKED: a package-local TypeBox copy exists at %s/node_modules/typebox. Run `npm ci --omit=peer --ignore-scripts` in the extracted Compass package, then retry.\n' "$ROOT" >&2
  tar -czf "${OUT}.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
  printf 'Evidence bundle: %s.tar.gz\n' "$OUT"
  exit 3
fi

# Export the actual installed package source contract; this is the exact versioned API evidence.
node "$ROOT/scripts/export-subagents-rpc-contract.mjs" --package "$SUBAGENTS_ROOT" --out "$OUT/pi-subagents-delegation-contract.txt" > "$OUT/contract-export.log" 2>&1 || {
  printf 'BLOCKED: installed pi-subagents contract export failed. See %s/contract-export.log.\n' "$OUT" >&2
  tar -czf "${OUT}.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
  printf 'Evidence bundle: %s.tar.gz\n' "$OUT"
  exit 4
}
if node "$ROOT/scripts/check-subagents-contract.mjs" --package "$SUBAGENTS_ROOT" > "$OUT/contract-check.log" 2>&1; then CONTRACT_RC=0; else CONTRACT_RC=$?; fi

if (cd "$ROOT" && npm test) > "$OUT/npm-test.log" 2>&1; then TEST_RC=0; else TEST_RC=$?; fi
if (cd "$ROOT" && npm run test:core) > "$OUT/npm-test-core.log" 2>&1; then CORE_RC=0; else CORE_RC=$?; fi
mkdir -p "$OUT/target-project"
printf '{"name":"pi-compass-acceptance-target","private":true}\n' > "$OUT/target-project/package.json"
chmod 600 "$OUT/target-project/package.json"
if (cd "$ROOT" && node scripts/preflight.mjs "$OUT/target-project" --static-only) > "$OUT/preflight-static.log" 2>&1; then PREFLIGHT_RC=0; else PREFLIGHT_RC=$?; fi
if node "$ROOT/scripts/check-subagents-config.mjs" --settings "$SETTINGS" --runtime-config "$SUBAGENTS_CONFIG" --package "$SUBAGENTS_ROOT/package.json" --strict > "$OUT/config-current.log" 2>&1; then CURRENT_CONFIG_RC=0; else CURRENT_CONFIG_RC=$?; fi

# Build private proposals for both configuration surfaces; never archive or print their contents.
node "$ROOT/scripts/merge-subagents-settings.mjs" --settings "$SETTINGS" --runtime-config "$SUBAGENTS_CONFIG" --out "$TMP_AGENT/settings.json" --runtime-out "$TMP_AGENT/extensions/subagent/config.json" > "$OUT/config-proposal.log" 2>&1 || {
  printf 'BLOCKED: could not prepare isolated settings. See %s/config-proposal.log.\n' "$OUT" >&2
  tar -czf "${OUT}.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
  printf 'Evidence bundle: %s.tar.gz\n' "$OUT"
  exit 5
}
if node "$ROOT/scripts/check-subagents-config.mjs" --settings "$TMP_AGENT/settings.json" --runtime-config "$TMP_AGENT/extensions/subagent/config.json" --package "$SUBAGENTS_ROOT/package.json" --strict > "$OUT/config-proposed.log" 2>&1; then PROPOSED_CONFIG_RC=0; else PROPOSED_CONFIG_RC=$?; fi

# Resolve the configured provider extension without printing settings contents.
PROVIDER_EXT="${PI_PROVIDER_EXTENSION:-}"
if [[ -z "$PROVIDER_EXT" ]]; then
  PROVIDER_EXT="$(node --input-type=module - "$TMP_AGENT/settings.json" <<'NODE'
import fs from 'node:fs';
const file = process.argv[2];
try {
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const extensions = settings?.subagents?.defaultExtensions;
  if (Array.isArray(extensions)) {
    const candidates = extensions
      .filter((item) => typeof item === 'string')
      .map((item) => item.startsWith('~/') ? `${process.env.HOME}/${item.slice(2)}` : item)
      .filter((item) => fs.existsSync(item));
    const found = candidates.find((item) => /pi-cliproxyapi-provider/i.test(item))
      ?? candidates.find((item) => /cliproxyapi/i.test(item))
      ?? (candidates.length === 1 ? candidates[0] : '');
    if (found) process.stdout.write(found);
  }
} catch {}
NODE
)"
fi
[[ -n "$PROVIDER_EXT" && -f "$PROVIDER_EXT" ]] || fail "Could not resolve the configured provider extension. Set PI_PROVIDER_EXTENSION to its extension entry file."
[[ -f "$SUBAGENTS_ROOT/bundle/index.js" ]] || fail "Expected pi-subagents extension entry bundle/index.js is missing."

# Keep real auth/model material local in a private temporary agent dir; never package it.
for file in auth.json models.json; do
  if [[ -f "$AGENT_DIR/$file" ]]; then install -m 600 "$AGENT_DIR/$file" "$TMP_AGENT/$file"; fi
done
# The isolated runtime config is the reviewed proposal produced above; do not
# overwrite it with the original config after merging.

# Validate the proposed settings before removing package autoload entries for this isolated run.
if [[ "$TEST_RC" -ne 0 || "$CORE_RC" -ne 0 || "$PREFLIGHT_RC" -ne 0 || "$PROPOSED_CONFIG_RC" -ne 0 || "$PI_VERSION_RC" -ne 0 || "$CONTRACT_RC" -ne 0 ]]; then
  cat > "$OUT/summary.txt" <<SUMMARY
Local acceptance blocked; Pi was not started.
full_tests_exit=$TEST_RC
core_tests_exit=$CORE_RC
static_preflight_exit=$PREFLIGHT_RC
current_settings_check_exit=$CURRENT_CONFIG_RC
proposed_settings_check_exit=$PROPOSED_CONFIG_RC
pi_version_check_exit=$PI_VERSION_RC
installed_contract_check_exit=$CONTRACT_RC
See individual logs in this evidence directory. The original Pi settings were not modified.
SUMMARY
  tar -czf "${OUT}.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
  printf 'Local checks blocked live acceptance. Evidence bundle: %s.tar.gz\n' "$OUT"
  exit 6
fi

# Explicitly load only the real provider, pi-subagents, and this Compass candidate.
# The temporary settings keep role/model policy but remove package autoload to avoid duplicate extensions.
node --input-type=module - "$TMP_AGENT/settings.json" <<'NODE'
import fs from 'node:fs';
const file = process.argv[2];
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
// This smoke must load only the three explicit CLI extensions below. Do not
// inherit the user's unrelated extension/package autoload list into the sandbox.
delete settings.extensions;
delete settings.packages;
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
NODE

printf '\nStarting isolated Pi session. When the TUI opens, run exactly:\n  /compass-live-acceptance\nWait for PASS/FAIL and the report path, then exit Pi.\nThe test makes at least three read-only child model calls; a DeepSeek fallback can add calls. It may incur provider cost.\nOriginal settings are not changed. The evidence archive excludes temporary auth/model settings and session transcripts.\n\n'
cd "$ROOT"
set +e
PI_CODING_AGENT_DIR="$TMP_AGENT" PI_CODING_AGENT_SESSION_DIR="$TMP_AGENT/sessions" PI_COMPASS_LIVE_REPORT_DIR="$OUT" \
  pi --extension "$PROVIDER_EXT" \
     --extension "$SUBAGENTS_ROOT/bundle/index.js" \
     --extension "$ROOT/src/index.ts" \
     --session-dir "$TMP_AGENT/sessions"
PI_RC=$?
set -e
printf '%s\n' "$PI_RC" > "$OUT/pi-exit-code.txt"

if [[ -s "$OUT/live-acceptance.json" ]]; then
  chmod 600 "$OUT/live-acceptance.json"
  if node "$ROOT/scripts/check-live-acceptance-report.mjs" --report "$OUT/live-acceptance.json" > "$OUT/live-report-check.txt" 2>&1; then LIVE_REPORT_RC=0; else LIVE_REPORT_RC=1; fi
else
  printf 'No live acceptance report found. Confirm that /compass-live-acceptance was run and finished.\n' > "$OUT/live-acceptance-missing.txt"
  LIVE_REPORT_RC=1
fi

cat > "$OUT/summary.txt" <<SUMMARY
Pi Compass $RELEASE local/live acceptance evidence
full_tests_exit=$TEST_RC
core_tests_exit=$CORE_RC
static_preflight_exit=$PREFLIGHT_RC
current_settings_check_exit=$CURRENT_CONFIG_RC
proposed_settings_check_exit=$PROPOSED_CONFIG_RC
pi_version_check_exit=$PI_VERSION_RC
installed_contract_check_exit=$CONTRACT_RC
pi_exit=$PI_RC
live_report_exit=$LIVE_REPORT_RC
provider_extension=$PROVIDER_EXT
pi_subagents_root=$SUBAGENTS_ROOT
No settings.json, auth.json, models.json, or session transcript is included in this bundle.
SUMMARY

tar -czf "${OUT}.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"
printf '\nEvidence bundle created: %s.tar.gz\n' "$OUT"
printf 'Review the archive contents before uploading. It contains logs, installed pi-subagents API source excerpts, and the bounded live acceptance report only.\n'
if [[ "$LIVE_REPORT_RC" -ne 0 ]]; then
  printf 'Live acceptance did not pass. Review %s/live-report-check.txt and live-acceptance.json before uploading.\n' "$OUT" >&2
  exit 7
fi
