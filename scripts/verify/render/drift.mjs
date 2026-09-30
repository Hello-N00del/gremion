// TASK-053 (L2-05; brief Q2): G-053-drift. The render guards judge TASK-040's
// FIXED fixture env files, but a host renders from the templates
// (infra/host/templates/env/<p>.env.tmpl). "Repo declares X, running system
// does Y" is the most repeated failure class on record, so per project the
// fixture's COMPOSE_FILE and COMPOSE_PROFILES must equal the template's:
//
//   - each key located BY KEY, exactly once in each file (a duplicate is its
//     own failure: which one compose reads is an accident);
//   - COMPOSE_PROFILES verbatim;
//   - COMPOSE_FILE entry by entry, same length, same order. The PINS SLOT (an
//     entry whose basename matches docker-compose*pins.yml) is compared by
//     POSITION, never by name: the fixture layers its own pins, and TASK-048b's
//     rename to docker-compose.state-pins.yml must not turn drift RED in either
//     merge order. Every other entry is compared verbatim.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PINS_SLOT } from './harness.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
export const TEMPLATE_DIR = 'infra/host/templates/env'
export const DRIFT_KEYS = ['COMPOSE_FILE', 'COMPOSE_PROFILES']

/** project id -> its template (app-blue and app-green share app.env.tmpl). */
export const templateFor = (projectId) => `${TEMPLATE_DIR}/${projectId.startsWith('app-') ? 'app' : projectId}.env.tmpl`

/** All values of `key` in KEY=VALUE lines (comments skipped). */
export function valuesOf(text, key) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m && m[1] === key) out.push(m[2].trim())
  }
  return out
}

/** Pure: the drift problems of one fixture/template pair. */
export function driftViolations({ projectId, fixtureText, templateText, fixtureName = 'fixture', templateName = 'template' }) {
  const out = []
  const got = {}
  for (const key of DRIFT_KEYS) {
    for (const [name, text] of [[fixtureName, fixtureText], [templateName, templateText]]) {
      const vals = valuesOf(text, key)
      if (vals.length === 0) out.push(`${projectId}: ${name} declares no ${key}`)
      else if (vals.length > 1) out.push(`${projectId}: ${name} declares ${key} ${vals.length} times`)
      else (got[name] ??= {})[key] = vals[0]
    }
  }
  if (out.length) return out
  const f = got[fixtureName]
  const t = got[templateName]
  if (f.COMPOSE_PROFILES !== t.COMPOSE_PROFILES) {
    out.push(`${projectId}: COMPOSE_PROFILES is ${JSON.stringify(f.COMPOSE_PROFILES)} in ${fixtureName}, ${JSON.stringify(t.COMPOSE_PROFILES)} in ${templateName}`)
  }
  const fl = f.COMPOSE_FILE.split(':')
  const tl = t.COMPOSE_FILE.split(':')
  if (fl.length !== tl.length) {
    out.push(`${projectId}: COMPOSE_FILE has ${fl.length} entr(ies) in ${fixtureName} (${f.COMPOSE_FILE}), ${tl.length} in ${templateName} (${t.COMPOSE_FILE})`)
    return out
  }
  for (let i = 0; i < tl.length; i++) {
    const tPins = PINS_SLOT.test(tl[i])
    const fPins = PINS_SLOT.test(fl[i])
    if (tPins || fPins) {
      if (!(tPins && fPins)) out.push(`${projectId}: COMPOSE_FILE entry ${i + 1} is ${fl[i]} in ${fixtureName}, ${tl[i]} in ${templateName} -- the pins slot moved or vanished`)
    } else if (fl[i] !== tl[i]) {
      out.push(`${projectId}: COMPOSE_FILE entry ${i + 1} is ${fl[i]} in ${fixtureName}, ${tl[i]} in ${templateName}`)
    }
  }
  return out
}

/** Drift of every project: [{ id, problems }]. A file that cannot be read is
 * a problem of its project, never a skip. */
export function driftChecks(projects, { root = REPO_ROOT, read = (f) => readFileSync(path.join(root, f), 'utf8') } = {}) {
  return projects.map((p) => {
    const tmpl = templateFor(p.id)
    let fixtureText
    let templateText
    try {
      fixtureText = read(p.envFile)
      templateText = read(tmpl)
    } catch (err) {
      return { id: p.id, problems: [`${p.id}: cannot read ${p.envFile} or ${tmpl}: ${err.message}`] }
    }
    return { id: p.id, problems: driftViolations({ projectId: p.id, fixtureText, templateText, fixtureName: p.envFile, templateName: tmpl }) }
  })
}
