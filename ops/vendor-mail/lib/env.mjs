// TASK-015: env-file and env-template reading for the ops/vendor-mail checks.
//
// ONE parser for the KEY=VALUE shape infra/host/lib/common.sh#load_env reads
// (the host's only whole-file reader; this is its read-only mirror for the
// checks, which never export anything). Comments and blank lines are skipped;
// one layer of matching quotes is stripped, exactly as compose --env-file and
// load_env do; a duplicate key is an error, never "last one wins".
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'infra', 'host', 'templates', 'env')
export const TEMPLATE_NAMES = ['state.env.tmpl', 'app.env.tmpl', 'mail.env.tmpl', 'ops.env.tmpl']

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
export const GEN_SENTINEL = /CHANGE_ME_GEN_(hex32|alnum32)_([a-z0-9_]+)/
const GEN_SENTINEL_ALL = /CHANGE_ME_GEN_(hex32|alnum32)_([a-z0-9_]+)/g

/** Parse env text into an ordered array of {key, value, line}. Throws on a
 * malformed line or a duplicate key (the message names the line, never the
 * content: a malformed line may hold a secret). */
export function parseEnv(text, label = 'env') {
  const out = []
  const seen = new Set()
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(#.*)?$/.test(raw)) return
    const m = KEY_LINE.exec(raw)
    if (!m) throw new Error(`${label}: line ${i + 1} is not KEY=VALUE (content not shown)`)
    if (seen.has(m[1])) throw new Error(`${label}: duplicate key ${m[1]}`)
    seen.add(m[1])
    let value = m[2]
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1)
    }
    out.push({ key: m[1], value, line: i + 1 })
  })
  return out
}

export function envMap(text, label) {
  return Object.fromEntries(parseEnv(text, label).map((e) => [e.key, e.value]))
}

export function readEnvMap(file) {
  return envMap(readFileSync(file, 'utf8'), path.basename(file))
}

/** Every generated-sentinel reference of a template: {key, group, kind, whole,
 * line}. `whole` is true when the value IS the sentinel (an alias of the
 * group), false when it merely embeds it (a URL's password). */
export function templateSentinels(text, label = 'template') {
  const refs = []
  for (const e of parseEnv(text, label)) {
    for (const m of e.value.matchAll(GEN_SENTINEL_ALL)) {
      refs.push({ key: e.key, kind: m[1], group: m[2], whole: e.value === m[0], line: e.line })
    }
  }
  return refs
}

export function readTemplates(dir = TEMPLATE_DIR) {
  return Object.fromEntries(TEMPLATE_NAMES.map((n) => [n, readFileSync(path.join(dir, n), 'utf8')]))
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')
