#!/usr/bin/env node
// TRD-140/141/142: generates docs/compliance/tom-annex.md, the dated TOM annex
// (technische und organisatorische Massnahmen, GDPR Art. 32), from measure
// inputs that already exist in the tree. Nothing is invented: every line is
// read out of a named source file, and a source that no longer yields its
// value is an error (exit 2), never a silently dropped or defaulted measure.
//
//   node scripts/gen-tom-annex.mjs [--date YYYY-MM-DD] [--root DIR]   write
//   node scripts/gen-tom-annex.mjs --check [--root DIR]               verify
//
// Digest: sha256 over the canonical list of extracted measures (id, value,
// source, locator) - the facts the annex states, not the raw bytes of files
// that merely contain them, so an unrelated edit to hooks.server.ts does not
// make the annex stale. --check fails when the committed annex's digest is not
// the digest of the current inputs, or when the file differs from its own
// regeneration (hand edit). Each change of digest appends one dated version
// to the annex's Versionsverlauf (TRD-141) naming the measures that changed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ANNEX_PATH = 'docs/compliance/tom-annex.md';

class SourceError extends Error {}

function read(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) throw new SourceError(`${rel}: source file is missing`);
  return readFileSync(p, 'utf8');
}
function must(rel, what, m) {
  if (!m) throw new SourceError(`${rel}: cannot find ${what}`);
  return m;
}

// ── extractors: each returns [{ id, group, measure, value, source, locator }] ──

function retentionCatalogue(root) {
  const rel = 'docs/compliance/retention-catalogue.md';
  const text = read(root, rel);
  const status = must(rel, 'the "Status:" line', text.match(/\*\*Status: ([A-Z]+),? dated (\d{4}-\d{2}-\d{2})/));
  const facts = [{
    id: 'RET-STATUS', group: 'Aufbewahrung', measure: 'Ableitungsstand des Fristenkatalogs',
    value: `${status[1]} vom ${status[2]}`, source: rel, locator: 'Status-Zeile',
  }];
  const rows = text.split('\n').filter((l) => /^\| RC-LOG-[A-Z]+ \|/.test(l));
  if (rows.length === 0) throw new SourceError(`${rel}: no RC-LOG-* rows found in section 4.1`);
  for (const row of rows) {
    const c = row.split('|').map((s) => s.trim());
    const w = must(rel, `"**N d / M d**" window in ${c[1]}`, c[5].match(/\*\*(\d+ d) \/ (\d+ d)\*\*/));
    facts.push({
      id: `RET-${c[1]}`, group: 'Aufbewahrung', measure: `Protokollklasse ${c[2]}`,
      value: `Regelfrist ${w[1]}, Obergrenze ${w[2]}`, source: rel, locator: `Abschnitt 4.1, Zeile ${c[1]}`,
    });
  }
  return facts;
}

function loki(root) {
  const rel = 'docker/loki/loki.yaml';
  const text = read(root, rel);
  const def = must(rel, 'limits_config.retention_period', text.match(/^\s*retention_period:\s*(\S+)/m));
  const facts = [{
    id: 'LOG-LOKI-DEFAULT', group: 'Protokolle', measure: 'Loki: Standard-Aufbewahrung',
    value: def[1], source: rel, locator: 'limits_config.retention_period',
  }];
  const re = /selector:\s*'\{class="(\w+)"\}'\s*\n\s*priority:\s*\d+\s*\n\s*period:\s*(\S+)/g;
  let n = 0;
  for (const m of text.matchAll(re)) {
    n++;
    facts.push({
      id: `LOG-LOKI-${m[1].toUpperCase()}`, group: 'Protokolle', measure: `Loki: Klasse ${m[1]}`,
      value: m[2], source: rel, locator: 'limits_config.retention_stream',
    });
  }
  if (n === 0) throw new SourceError(`${rel}: no retention_stream entries found`);
  return facts;
}

function tempo(root) {
  const rel = 'docker/tempo/tempo.yaml';
  const m = must(rel, 'block_retention', read(root, rel).match(/^\s*block_retention:\s*(\S+)/m));
  return [{
    id: 'LOG-TEMPO-BLOCK', group: 'Protokolle', measure: 'Tempo: Trace-Aufbewahrung',
    value: m[1], source: rel, locator: 'compactor.compaction.block_retention',
  }];
}

function moduleExports(root) {
  const facts = [];
  const dir = join(root, 'modules');
  if (!existsSync(dir)) throw new SourceError('modules/: directory is missing');
  for (const name of readdirSync(dir).sort()) {
    const rel = `modules/${name}/module.json`;
    if (!existsSync(join(root, rel))) continue;
    const exp = JSON.parse(read(root, rel))?.runtime?.export;
    if (!exp) continue;
    if (!exp.retentionProfile) throw new SourceError(`${rel}: runtime.export has no retentionProfile`);
    facts.push({
      id: `MOD-${name.toUpperCase()}`, group: 'Module', measure: `Modul ${name}: Export bei Deaktivierung`,
      value: `${exp.kind}, Aufbewahrungsprofil ${exp.retentionProfile}`, source: rel,
      locator: 'runtime.export',
    });
  }
  if (facts.length === 0) throw new SourceError('modules/*/module.json: no module declares runtime.export');
  return facts;
}

const REALM_KEYS = [
  ['AUTH-SSL', 'sslRequired', 'Keycloak: TLS-Pflicht (sslRequired)'],
  ['AUTH-BRUTE', 'bruteForceProtected', 'Keycloak: Schutz gegen Brute-Force'],
  ['AUTH-FAILS', 'failureFactor', 'Keycloak: Fehlversuche bis Sperre'],
  ['AUTH-WAIT', 'maxFailureWaitSeconds', 'Keycloak: maximale Sperrzeit (s)'],
  ['AUTH-ATL', 'accessTokenLifespan', 'Keycloak: Lebensdauer Access-Token (s)'],
  ['AUTH-IDLE', 'ssoSessionIdleTimeout', 'Keycloak: SSO-Leerlaufzeit (s)'],
  ['AUTH-MAX', 'ssoSessionMaxLifespan', 'Keycloak: SSO-Hoechstdauer (s)'],
  ['AUTH-OTP-TYPE', 'otpPolicyType', 'Keycloak: zweiter Faktor, Verfahren'],
  ['AUTH-OTP-DIGITS', 'otpPolicyDigits', 'Keycloak: zweiter Faktor, Stellen'],
  ['AUTH-OTP-PERIOD', 'otpPolicyPeriod', 'Keycloak: zweiter Faktor, Periode (s)'],
  ['LOG-KC-EVENTS', 'eventsEnabled', 'Keycloak: Anmeldeereignisse protokolliert'],
  ['LOG-KC-EXP', 'eventsExpiration', 'Keycloak: Ablauf Anmeldeereignisse (s)'],
  ['LOG-KC-ADMIN', 'adminEventsEnabled', 'Keycloak: Admin-Ereignisse protokolliert'],
  ['LOG-KC-ADMIN-EXP', 'attributes.adminEventsExpiration', 'Keycloak: Ablauf Admin-Ereignisse (s)'],
  ['AUTH-ACR', 'attributes.acr.loa.map', 'Keycloak: Zuordnung ACR zu Vertrauensniveau'],
];

function realm(root) {
  const rel = 'docker/keycloak/realm-export.base.json';
  const json = JSON.parse(read(root, rel));
  return REALM_KEYS.map(([id, key, measure]) => {
    let v;
    if (key.startsWith('attributes.')) v = json.attributes?.[key.slice('attributes.'.length)];
    else v = json[key];
    if (v === undefined) throw new SourceError(`${rel}: key ${key} is missing`);
    return {
      id, group: id.startsWith('LOG-') ? 'Protokolle' : 'Zugriff und Authentisierung', measure,
      value: String(v), source: rel, locator: key,
    };
  });
}

function stepUp(root) {
  const rel = 'gremion-ui/src/lib/auth/step-up.ts';
  const m = must(rel, 'LOA = { PASSWORD: n, STEP_UP: n }', read(root, rel).match(/LOA\s*=\s*\{\s*PASSWORD:\s*(\d+),\s*STEP_UP:\s*(\d+)\s*\}/));
  return [{
    id: 'AUTH-STEPUP', group: 'Zugriff und Authentisierung', measure: 'Step-up fuer erhoehte Handlungen',
    value: `Vertrauensniveau Passwort ${m[1]}, Step-up ${m[2]}`, source: rel, locator: 'LOA',
  }];
}

// CSP keywords that CSP syntax requires to be single-quoted.
const CSP_KEYWORDS = new Set(['self', 'none', 'unsafe-inline', 'unsafe-eval', 'strict-dynamic']);

// The page policy is owned by SvelteKit: `kit.csp.directives` in svelte.config.js. In
// mode 'auto' SvelteKit adds a per-response nonce to script-src, so the annex states that
// and nothing about 'unsafe-inline' for script-src unless the config lists it.
function pagePolicy(root) {
  const rel = 'gremion-ui/svelte.config.js';
  const text = read(root, rel);
  const csp = must(rel, 'kit.csp { mode, directives }', text.match(/\bcsp:\s*\{\s*mode:\s*'([a-z]+)',\s*directives:\s*\{([\s\S]*?)\}\s*\}/));
  const mode = csp[1];
  const directives = [...csp[2].matchAll(/'([a-z-]+)':\s*\[([^\]]*)\]/g)].map((m) => {
    const sources = [...m[2].matchAll(/'([^']+)'/g)].map((s) => (CSP_KEYWORDS.has(s[1]) ? `'${s[1]}'` : s[1]));
    if (m[1] === 'script-src' && mode === 'auto') sources.push("'nonce-<pro Antwort>'");
    return { name: m[1], value: [m[1], ...sources].join(' ') };
  });
  if (directives.length === 0) throw new SourceError(`${rel}: kit.csp has no directives`);
  return directives.map(({ name, value }) => ({
    id: `HDR-CSP-${name.toUpperCase()}`, group: 'Transport und Browserschutz',
    measure: `Content-Security-Policy: ${name}`, value, source: rel, locator: 'kit.csp',
  }));
}

function securityHeaders(root) {
  const rel = 'gremion-ui/src/hooks.server.ts';
  const text = read(root, rel);
  // frame-ancestors is header-only (a <meta> CSP ignores it), so it is not in kit.csp.
  const fa = must(rel, 'export const CSP_HEADER_VALUE = "frame-ancestors ..."', text.match(/export const CSP_HEADER_VALUE\s*=\s*"(frame-ancestors [^"]+)"/));
  const facts = [
    ...pagePolicy(root),
    {
      id: 'HDR-CSP-FRAME-ANCESTORS', group: 'Transport und Browserschutz',
      measure: 'Content-Security-Policy: frame-ancestors', value: fa[1], source: rel, locator: 'CSP_HEADER_VALUE',
    },
  ];
  for (const h of ['X-Content-Type-Options', 'Referrer-Policy']) {
    const m = must(rel, `headers.set('${h}', ...)`, text.match(new RegExp(`headers\\.set\\('${h}',\\s*'([^']+)'\\)`)));
    facts.push({
      id: `HDR-${h.toUpperCase()}`, group: 'Transport und Browserschutz', measure: `Header ${h}`,
      value: m[1], source: rel, locator: 'cspGuard',
    });
  }
  const cc = must(rel, "headers.set('Cache-Control', ...)", text.match(/headers\.set\('Cache-Control',\s*'([^']+)'\)/));
  facts.push({
    id: 'HDR-CACHE-CONTROL', group: 'Transport und Browserschutz', measure: 'Header Cache-Control (HTML-Seiten)',
    value: cc[1], source: rel, locator: 'cspGuard',
  });
  return facts;
}

function backup(root) {
  const rel = 'scripts/backup.sh';
  const text = read(root, rel);
  const days = must(rel, 'BACKUP_LOCAL_RETENTION_DAYS default', text.match(/BACKUP_LOCAL_RETENTION_DAYS:-(\d+)/));
  must(rel, 'RESTIC_PASSWORD (repository encryption)', text.match(/RESTIC_PASSWORD/));
  return [
    {
      id: 'BAK-CRYPT', group: 'Datensicherung', measure: 'Verschluesselung des Backup-Repositorys',
      value: 'restic-Repository, durch RESTIC_PASSWORD verschluesselt', source: rel, locator: 'RESTIC_PASSWORD',
    },
    {
      id: 'BAK-LOCAL', group: 'Datensicherung', measure: 'Lokale Aufbewahrung der Sicherungen',
      value: `${days[1]} d (Standard)`, source: rel, locator: 'BACKUP_LOCAL_RETENTION_DAYS',
    },
  ];
}

export function collectMeasures(root) {
  const all = [
    ...retentionCatalogue(root), ...loki(root), ...tempo(root), ...moduleExports(root),
    ...realm(root), ...stepUp(root), ...securityHeaders(root), ...backup(root),
  ];
  const seen = new Set();
  for (const f of all) {
    if (seen.has(f.id)) throw new SourceError(`duplicate measure id ${f.id}`);
    seen.add(f.id);
  }
  return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function digestOf(measures) {
  const canon = measures.map((m) => [m.id, m.value, m.source, m.locator]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// ── rendering and parsing of the annex ──

const esc = (s) => String(s).replaceAll('|', '\\|');

export function parseAnnex(text) {
  const history = [];
  const values = new Map();
  for (const line of text.split('\n')) {
    const h = line.match(/^\| (\d+) \| (\d{4}-\d{2}-\d{2}) \| ([0-9a-f]{64}) \| (.*) \|$/);
    if (h) history.push({ version: Number(h[1]), date: h[2], digest: h[3], changed: h[4] });
    const m = line.match(/^\| ([A-Z]+(?:-[A-Za-z0-9]+)+) \| .*? \| (.*?) \| `[^`]+` \|$/);
    if (m) values.set(m[1], m[2]);
  }
  return { history, values };
}

export function render(measures, digest, history) {
  const cur = history[history.length - 1];
  const groups = [...new Set(measures.map((m) => m.group))];
  const out = [];
  out.push('# TOM-Annex (technische und organisatorische Massnahmen, Art. 32 DSGVO)', '');
  out.push('> **Erzeugt** von `scripts/gen-tom-annex.mjs` aus den unten zitierten Quelldateien (TRD-140, TRD-141).');
  out.push('> Nicht von Hand aendern: eine Aenderung an einer Quelle wird im Release-Lint (`--check`) als');
  out.push('> veralteter Annex abgewiesen; neu erzeugen mit `node scripts/gen-tom-annex.mjs`. Jede Zeile nennt ihre');
  out.push('> Quelle; was dort nicht steht, steht hier nicht. Der Annex gibt den Stand der Konfiguration im Repository');
  out.push('> wieder, nicht den Betriebszustand eines Rats. Er ersetzt weder die Abschnitte 4a und 5 in');
  out.push('> `docs/compliance/controller-processor-split.md` noch deren offene Punkte (`TBD`: Festplattenverschluesselung,');
  out.push('> Offsite-Ziel, Backup-Gate), und er wird dem Auftragsverarbeitungsvertrag in der zum Unterschriftsdatum');
  out.push('> aktuellen Fassung beigefuegt (TRD-142).', '');
  out.push('| | |', '|---|---|');
  out.push(`| Version | ${cur.version} |`);
  out.push(`| Stand | ${cur.date} |`);
  out.push(`| Eingabe-Digest | ${digest} |`);
  out.push(`| Massnahmen | ${measures.length} |`);
  out.push('', 'Der Digest ist SHA-256 ueber die Liste (Id, Wert, Quelle, Fundstelle) aller Massnahmen unten.', '');
  out.push('## 1. Massnahmen', '');
  for (const g of groups) {
    out.push(`### ${g}`, '', '| Id | Massnahme | Wert | Quelle |', '|---|---|---|---|');
    for (const m of measures.filter((x) => x.group === g)) {
      out.push(`| ${m.id} | ${esc(m.measure)} | ${esc(m.value)} | \`${m.source}\` |`);
    }
    out.push('');
  }
  out.push('## 2. Fundstellen', '', '| Id | Fundstelle in der Quelle |', '|---|---|');
  for (const m of measures) out.push(`| ${m.id} | ${esc(m.locator)} |`);
  out.push('', '## 3. Versionsverlauf', '', '| Version | Datum | Digest | Geaenderte Massnahmen |', '|---|---|---|---|');
  for (const h of history) out.push(`| ${h.version} | ${h.date} | ${h.digest} | ${h.changed} |`);
  out.push('');
  return out.join('\n');
}

function changedIds(measures, prior) {
  const ids = [];
  const now = new Map(measures.map((m) => [m.id, m.value]));
  for (const [id, v] of now) if (prior.get(id) !== v) ids.push(id);
  for (const id of prior.keys()) if (!now.has(id)) ids.push(id);
  return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readAnnex(root) {
  const p = join(root, ANNEX_PATH);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

export function generate(root, date) {
  const measures = collectMeasures(root);
  const digest = digestOf(measures);
  const prior = readAnnex(root);
  const parsed = prior ? parseAnnex(prior) : { history: [], values: new Map() };
  const history = [...parsed.history];
  const last = history[history.length - 1];
  if (!last || last.digest !== digest) {
    const changed = last ? changedIds(measures, parsed.values) : [];
    history.push({
      version: (last?.version ?? 0) + 1, date, digest,
      changed: last ? (changed.join(', ') || 'Quellangaben') : 'erste Fassung',
    });
  }
  const text = render(measures, digest, history);
  if (text !== prior) writeFileSync(join(root, ANNEX_PATH), text);
  return { text, version: history[history.length - 1].version, changed: text !== prior };
}

export function check(root) {
  const measures = collectMeasures(root);
  const digest = digestOf(measures);
  const prior = readAnnex(root);
  if (prior === null) return { ok: false, message: `${ANNEX_PATH} is missing; run: node scripts/gen-tom-annex.mjs` };
  const parsed = parseAnnex(prior);
  const last = parsed.history[parsed.history.length - 1];
  if (!last) return { ok: false, message: `${ANNEX_PATH} has no Versionsverlauf; regenerate it` };
  if (last.digest !== digest) {
    const ids = changedIds(measures, parsed.values);
    return {
      ok: false,
      message: `${ANNEX_PATH} is stale: inputs changed since version ${last.version} (${last.date})`
        + `${ids.length ? `; measures: ${ids.join(', ')}` : ''}. Regenerate: node scripts/gen-tom-annex.mjs`,
    };
  }
  if (render(measures, digest, parsed.history) !== prior) {
    return { ok: false, message: `${ANNEX_PATH} differs from its regeneration (edited by hand?). Regenerate: node scripts/gen-tom-annex.mjs` };
  }
  return { ok: true, message: `${ANNEX_PATH}: up to date (version ${last.version}, ${last.date}, ${measures.length} measures)` };
}

function main(argv) {
  const opt = { check: false, root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), date: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') opt.check = true;
    else if (argv[i] === '--root') opt.root = resolve(argv[++i] ?? '');
    else if (argv[i] === '--date') opt.date = argv[++i] ?? '';
    else { console.error(`gen-tom-annex: unknown argument ${argv[i]}`); return 2; }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opt.date)) { console.error('gen-tom-annex: --date must be YYYY-MM-DD'); return 2; }
  try {
    if (opt.check) {
      const r = check(opt.root);
      (r.ok ? console.log : console.error)(`gen-tom-annex: ${r.message}`);
      return r.ok ? 0 : 1;
    }
    const r = generate(opt.root, opt.date);
    console.log(`gen-tom-annex: ${ANNEX_PATH} version ${r.version}${r.changed ? ' written' : ' unchanged'}`);
    return 0;
  } catch (e) {
    if (e instanceof SourceError) { console.error(`gen-tom-annex: ${e.message}`); return 2; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
