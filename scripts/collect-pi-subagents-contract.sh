#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only compatibility evidence collector for the locally installed pi-subagents.
# It does not read Pi settings, auth.json, models.json, environment credentials, or sessions.
# It writes one plain-text report and never modifies the installed package.

ROOT="${PI_SUBAGENTS_ROOT:-$HOME/.pi/agent/npm/node_modules/pi-subagents}"
OUT=""
while (($#)); do
  case "$1" in
    --package)
      [[ $# -ge 2 ]] || { echo 'Missing value for --package' >&2; exit 2; }
      ROOT="$2"; shift 2 ;;
    --out)
      [[ $# -ge 2 ]] || { echo 'Missing value for --out' >&2; exit 2; }
      OUT="$2"; shift 2 ;;
    -h|--help)
      cat <<'HELP'
Usage:
  bash collect-pi-subagents-contract.sh [--package /path/to/pi-subagents] [--out /tmp/pi-subagents-contract.txt]

Default package path:
  ~/.pi/agent/npm/node_modules/pi-subagents

The report includes package identity, delegation type declarations, selected runtime source excerpts,
relevant documentation, and SHA-256 hashes. It does NOT read Pi settings or credentials.
HELP
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OUT" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  OUT="/tmp/pi-subagents-contract-${stamp}.txt"
fi

command -v node >/dev/null 2>&1 || { echo 'Node.js is required.' >&2; exit 2; }
[[ -d "$ROOT" ]] || { echo "Package directory not found: $ROOT" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"

node --input-type=module - "$ROOT" "$OUT" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const chunks = [];
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const hash = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'MISSING'; } };
const add = (title, body) => chunks.push(`\n===== ${title} =====\n${body?.trim() || '[MISSING OR EMPTY]'}\n`);
const excerpt = (relative, maxBytes = 60000) => {
  const p = path.join(root, relative);
  if (!exists(p)) return `[MISSING] ${relative}`;
  const body = read(p);
  return `Path: ${relative}\nSHA-256: ${hash(p)}\nBytes: ${Buffer.byteLength(body)}\n\n${body.slice(0, maxBytes)}${Buffer.byteLength(body) > maxBytes ? '\n[TRUNCATED BY COLLECTOR]' : ''}`;
};
const docMatches = (relative, regex, maxLines = 180) => {
  const p = path.join(root, relative);
  if (!exists(p)) return `[MISSING] ${relative}`;
  const lines = read(p).split(/\r?\n/);
  const selected = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 7); j++) selected.add(j);
  }
  return `Path: ${relative}\nSHA-256: ${hash(p)}\n${[...selected].sort((a,b)=>a-b).slice(0,maxLines).map(i=>`${i+1}: ${lines[i]}`).join('\n') || '[No matching lines found]'}`;
};

let manifest = null;
let manifestError = '';
try { manifest = JSON.parse(read(path.join(root, 'package.json'))); }
catch (e) { manifestError = String(e); }
add('Collection metadata', [
  `Package root: ${root}`,
  `Generated at: ${new Date().toISOString()}`,
  'Read-only collector. Does not read settings.json, auth.json, models.json, environment credentials, or session transcripts.',
  'Report can include source code from the installed extension; review before sharing if you maintain private modifications.'
].join('\n'));
add('Installed package identity', manifest ? JSON.stringify({name:manifest.name, version:manifest.version, exports:manifest.exports, pi:manifest.pi}, null, 2) : `Could not parse package.json: ${manifestError}`);

const files = [
  'src/api/delegation.d.ts',
  'bundle/delegation.js',
  'src/api/shared-types.d.ts',
  'src/api/control-channel.d.ts',
];
for (const relative of files) add(relative, excerpt(relative, 60000));

const bundleIndexPath = path.join(root, 'bundle/index.js');
if (exists(bundleIndexPath)) {
  const body = read(bundleIndexPath);
  const lines = body.split(/\r?\n/);
  const patterns = [
    /prompt-template:subagent:(?:request|started|update|response|cancel)/i,
    /SUBAGENT_DELEGATION_(?:REQUEST|STARTED|UPDATE|RESPONSE|CANCEL)_EVENT/i,
    /ownerRunId|nodeId|requestId/i,
    /duplicate_node|invalid_request|structured_output_failed|unavailable_context/i,
  ];
  const picked = new Set();
  for (const pattern of patterns) {
    let hits = 0;
    for (let i = 0; i < lines.length && hits < 30; i++) {
      if (!pattern.test(lines[i])) continue;
      hits++;
      for (let j = Math.max(0, i - 8); j <= Math.min(lines.length - 1, i + 14); j++) picked.add(j);
    }
  }
  add('bundle/index.js event and payload excerpts', `Path: bundle/index.js\nSHA-256: ${hash(bundleIndexPath)}\n${[...picked].sort((a,b)=>a-b).map(i=>`${i+1}: ${lines[i]}`).join('\n') || '[No matching lines found; bundle may be minified or use different event names]'}`);
} else add('bundle/index.js event and payload excerpts', '[MISSING] bundle/index.js');

for (const [relative, regex] of [
  ['docs/extension-api.md', /structured delegation|delegation|prompt-template:subagent|requestId|ownerRunId|nodeId|foreground/i],
  ['docs/tool-reference.md', /workflow: true|workflowScript|runs\.all|structured output|timeoutMs|toolBudget/i],
  ['docs/configuration.md', /defaultModel|defaultThinking|modelScope|agentOverrides|fallbackModels|globalConcurrencyLimit|maxSubagentDepth/i],
]) add(`${relative} relevant excerpts`, docMatches(relative, regex));

const required = ['package.json','src/api/delegation.d.ts','bundle/delegation.js','bundle/index.js'];
const missing = required.filter((rel) => !exists(path.join(root, rel)));
const allText = chunks.join('\n');
const eventNames = ['prompt-template:subagent:request','prompt-template:subagent:started','prompt-template:subagent:update','prompt-template:subagent:response','prompt-template:subagent:cancel'];
const foundEvents = eventNames.filter((name) => allText.includes(name));
add('Collector summary', [
  `Required files missing: ${missing.length ? missing.join(', ') : 'none'}`,
  `Known event names present in collected source/docs: ${foundEvents.length ? foundEvents.join(', ') : 'none detected'}`,
  'This is evidence collection only; it does not assert that Compass is compatible with this contract.',
  missing.length ? 'Collection status: INCOMPLETE — inspect missing paths or pass --package with the actual package root.' : 'Collection status: COMPLETE — review the declarations and event/payload excerpts before live execution.'
].join('\n'));

fs.writeFileSync(out, `pi-subagents local compatibility evidence\n${chunks.join('\n')}\n`, {encoding:'utf8', mode:0o600});
try { fs.chmodSync(out, 0o600); } catch {}
console.log(`Package: ${manifest?.name ?? 'unknown'}@${manifest?.version ?? 'unknown'}`);
console.log(`Report: ${out}`);
console.log(`Status: ${missing.length ? 'INCOMPLETE' : 'COMPLETE'}`);
console.log('No Pi settings or credentials were read.');
if (!manifest || manifest.name !== 'pi-subagents') process.exitCode = 3;
else if (missing.length) process.exitCode = 4;
NODE
