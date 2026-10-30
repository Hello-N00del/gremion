// TRD-140/141: the generated TOM annex. Golden output for fixture inputs, and
// the staleness check (--check) failing after an input changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'gen-tom-annex.mjs');
const FIXTURE = join(here, 'fixtures', 'tom-annex', 'root');
const GOLDEN = join(here, 'fixtures', 'tom-annex', 'expected-tom-annex.md');
const ANNEX = 'docs/compliance/tom-annex.md';

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tom-annex-'));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}
function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
}

test('generates the golden annex for the fixture inputs', () => {
  const root = freshRoot();
  const r = run(root, '--date', '2026-10-27');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(root, ANNEX), 'utf8'), readFileSync(GOLDEN, 'utf8'));
});

test('--check fails when no annex has been committed', () => {
  const r = run(freshRoot(), '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tom-annex\.md.*missing/i);
});

test('--check passes right after generating', () => {
  const root = freshRoot();
  assert.equal(run(root, '--date', '2026-10-27').status, 0);
  const r = run(root, '--check');
  assert.equal(r.status, 0, r.stderr);
});

test('--check fails after a retention window changes, naming the measure; regenerating fixes it', () => {
  const root = freshRoot();
  run(root, '--date', '2026-10-27');
  const cat = join(root, 'docs/compliance/retention-catalogue.md');
  writeFileSync(cat, readFileSync(cat, 'utf8').replace('**14 d / 30 d**', '**7 d / 30 d**'));
  const stale = run(root, '--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale/i);
  assert.match(stale.stderr, /RET-RC-LOG-ACC/);
  const regen = run(root, '--date', '2026-11-02');
  assert.equal(regen.status, 0, regen.stderr);
  const ok = run(root, '--check');
  assert.equal(ok.status, 0, ok.stderr);
  const text = readFileSync(join(root, ANNEX), 'utf8');
  assert.match(text, /\| Version \| 2 \|/);
  assert.match(text, /\| 1 \| 2026-10-27 \|/);
  assert.match(text, /\| 2 \| 2026-11-02 \| [0-9a-f]{64} \| RET-RC-LOG-ACC \|/);
});

test('regenerating unchanged inputs keeps the version and date (idempotent)', () => {
  const root = freshRoot();
  run(root, '--date', '2026-10-27');
  const before = readFileSync(join(root, ANNEX), 'utf8');
  assert.equal(run(root, '--date', '2027-01-01').status, 0);
  assert.equal(readFileSync(join(root, ANNEX), 'utf8'), before);
});

test('--check fails when the annex was edited by hand', () => {
  const root = freshRoot();
  run(root, '--date', '2026-10-27');
  const p = join(root, ANNEX);
  writeFileSync(p, readFileSync(p, 'utf8').replace('nosniff', 'sniff-away'));
  assert.equal(run(root, '--check').status, 1);
});

test('a missing source value is an error, never an invented measure', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'docker/tempo/tempo.yaml'), 'compactor: {}\n');
  const r = run(root, '--date', '2026-10-27');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /docker\/tempo\/tempo\.yaml/);
  assert.equal(existsSync(join(root, ANNEX)), false);
});

test('the CSP measures state the nonce-based page policy, not the proxied-HTML baseline', () => {
  const root = freshRoot();
  assert.equal(run(root, '--date', '2026-10-27').status, 0);
  const text = readFileSync(join(root, ANNEX), 'utf8');
  const script = text.split('\n').find((l) => l.startsWith('| HDR-CSP-SCRIPT-SRC |'));
  assert.ok(script, 'no script-src row');
  assert.match(script, /script-src 'self' 'nonce-/);
  assert.doesNotMatch(script, /unsafe-inline/);
  assert.match(script, /`gremion-ui\/svelte\.config\.js`/);
  // frame-ancestors is a header-only directive set in hooks.server.ts, not in kit.csp
  const frame = text.split('\n').find((l) => l.startsWith('| HDR-CSP-FRAME-ANCESTORS |'));
  assert.match(frame, /`gremion-ui\/src\/hooks\.server\.ts`/);
  assert.match(text, /\| HDR-CACHE-CONTROL \| .* \| no-store \|/);
});

test('a source without a kit.csp block is an error, never a policy invented from the baseline', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'gremion-ui/svelte.config.js'), 'export default { kit: {} }\n');
  const r = run(root, '--date', '2026-10-27');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /svelte\.config\.js/);
  assert.equal(existsSync(join(root, ANNEX)), false);
});

test('every measure row cites a source file that exists', () => {
  const root = freshRoot();
  run(root, '--date', '2026-10-27');
  const rows = readFileSync(join(root, ANNEX), 'utf8').split('\n').filter((l) => /^\| [A-Z]+(-[A-Za-z0-9]+)+ \|/.test(l) && l.split('|').length === 6);
  assert.ok(rows.length > 10);
  for (const row of rows) {
    const m = row.match(/`([^`]+)` \|$/);
    assert.ok(m, `no source on: ${row}`);
    assert.ok(existsSync(join(root, m[1])), `source ${m[1]} missing`);
  }
});
