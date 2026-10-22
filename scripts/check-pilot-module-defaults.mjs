#!/usr/bin/env node
// Pilot module defaults - TASK-058-A (PRD-ELE-001, TRD-030, TRD-064).
//
// Repo-side checks of the claim "a pilot customer starts with votes only". They
// read files; they do NOT prove the running system (that is 058-B, blocked on
// TASK-044-b). Four checks, each with a falsifiable failure:
//   (a) test/host/fixtures/module-defaults/pilot-request.json enables votes and none of
//       elections|finance|board|vault|content|handover; every id has modules/<id>/module.json
//   (b) no infra/host/templates/env/*.env.tmpl COMPOSE_PROFILES value names
//       finance|board|vault|content|vaultwarden
//   (c) no modules/*/module.json declares a default-enable key (anywhere in the JSON)
//   (d) the panel create form preselects no module checkbox
//
// Run:  node scripts/check-pilot-module-defaults.mjs
// Test: node --test scripts/check-pilot-module-defaults.test.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const REQUEST_PATH = 'test/host/fixtures/module-defaults/pilot-request.json'
export const PANEL_FORM = 'apps/control-panel/src/routes/(shell)/customers/new/+page.svelte'
export const ENV_DIR = 'infra/host/templates/env'
export const FORBIDDEN_IDS = ['elections', 'finance', 'board', 'vault', 'content', 'handover']
export const FORBIDDEN_PROFILES = ['finance', 'board', 'vault', 'content', 'vaultwarden']
const DEFAULT_KEY = /^(default|defaults|defaultEnabled|enabledByDefault|enableByDefault|autoEnable|preselected|defaultOn)$/i

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

export function checkRequest(root) {
  const bad = []
  let req
  try {
    req = readJson(root, REQUEST_PATH)
  } catch (e) {
    return [`(a) ${REQUEST_PATH} unreadable: ${e.message}`]
  }
  const enable = Array.isArray(req.enable) ? req.enable : null
  if (!enable) return [`(a) ${REQUEST_PATH}: "enable" is not an array`]
  if (!enable.includes('votes')) bad.push('(a) the pilot request does not enable votes')
  for (const id of enable) {
    if (FORBIDDEN_IDS.includes(id)) bad.push(`(a) the pilot request enables "${id}"`)
    if (!existsSync(join(root, 'modules', String(id), 'module.json'))) bad.push(`(a) "${id}" has no modules/${id}/module.json`)
  }
  return bad
}

export function composeProfiles(root) {
  const dir = join(root, ENV_DIR)
  const out = []
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.env.tmpl')).sort()) {
    readFileSync(join(dir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = /^\s*COMPOSE_PROFILES\s*=\s*(.*)$/.exec(line)
      if (m) out.push({ file: f, line: i + 1, profiles: m[1].split(',').map((s) => s.trim()).filter(Boolean) })
    })
  }
  return out
}

export function checkComposeProfiles(root) {
  const lines = composeProfiles(root)
  if (lines.length === 0) return [`(b) no COMPOSE_PROFILES line found under ${ENV_DIR}: an empty scan proves nothing`]
  const bad = []
  for (const l of lines)
    for (const p of l.profiles)
      if (FORBIDDEN_PROFILES.includes(p)) bad.push(`(b) ${l.file}:${l.line} COMPOSE_PROFILES names "${p}"`)
  return bad
}

function defaultKeys(node, path, out) {
  if (Array.isArray(node)) node.forEach((v, i) => defaultKeys(v, `${path}[${i}]`, out))
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (DEFAULT_KEY.test(k)) out.push(`${path}.${k}`)
      defaultKeys(v, `${path}.${k}`, out)
    }
}

export function checkModuleManifests(root) {
  const mdir = join(root, 'modules')
  const ids = existsSync(mdir) ? readdirSync(mdir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(mdir, d.name, 'module.json'))).map((d) => d.name) : []
  if (ids.length === 0) return ['(c) no modules/*/module.json found: an empty scan proves nothing']
  const bad = []
  for (const id of ids) {
    const hits = []
    defaultKeys(readJson(root, `modules/${id}/module.json`), 'module.json', hits)
    for (const h of hits) bad.push(`(c) modules/${id}/${h} declares a default-enable key`)
  }
  return bad
}

export function checkPanelForm(root) {
  const p = join(root, PANEL_FORM)
  if (!existsSync(p)) return [`(d) ${PANEL_FORM} not found`]
  const src = readFileSync(p, 'utf8')
  const bad = []
  const boxes = src.match(/<input\b[^>]*type="checkbox"[^>]*>/g) ?? []
  if (boxes.length === 0) bad.push('(d) the panel form has no module checkbox: an empty scan proves nothing')
  for (const b of boxes) {
    const attr = /\bchecked\b(\s*=\s*(\{[^}]*\}|"[^"]*"))?/.exec(b)
    if (attr && attr[0] !== 'checked={checkedModules.includes(m.id)}') bad.push(`(d) a module checkbox is preselected: ${attr[0]}`)
  }
  const d = /const checkedModules\s*=\s*\$derived\(([^\n]*)\)/.exec(src)
  if (!d) bad.push('(d) checkedModules definition not found')
  else if (!/values\.enable/.test(d[1]) || !/:\s*\[\]\s*$/.test(d[1])) bad.push(`(d) checkedModules is not "chosen in a failed submit, else empty": ${d[1]}`)
  return bad
}

export function runChecks(root = ROOT) {
  const failures = [...checkRequest(root), ...checkComposeProfiles(root), ...checkModuleManifests(root), ...checkPanelForm(root)]
  return { ok: failures.length === 0, failures }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = runChecks()
  if (!r.ok) {
    console.error(`[pilot-module-defaults] ${r.failures.length} failure(s):\n  ` + r.failures.join('\n  '))
    process.exit(1)
  }
  console.log('[pilot-module-defaults] OK (a) request (b) compose profiles (c) manifests (d) panel form')
}
