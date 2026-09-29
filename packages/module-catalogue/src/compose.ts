// packages/module-catalogue/src/compose.ts
//
// Reads a compose file into the ComposeModel the catalogue checks against:
// per service, the org.gremion.postgres label and the environment with
// ${VAR:-default} resolved to its default. Merge keys (`<<: *module-postgres`,
// the kernel file's x-module-postgres anchor) are applied; labels and
// environment are read in both the map and the list form.
//
// Like runtime.ts, this file is imported by @gremion/tenant-store's specs
// (`@gremion/module-catalogue/compose`) and type-checked under that
// package's flags, so its one relative import is type-only.
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { ComposeModel, ComposeService } from './runtime.ts'

/** = runtime.ts POSTGRES_LABEL (test/catalogue.test.ts asserts the two agree). */
export const COMPOSE_POSTGRES_LABEL = 'org.gremion.postgres'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `${VAR:-default}` / `${VAR-default}` -> default; `${VAR}` / `${VAR:?msg}` -> undefined; a literal stays. */
const scalar = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined

export function composeDefault(value: unknown): string | undefined {
  const s = scalar(value)
  if (s === undefined) return undefined
  const whole = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^}]*))?(?::?\?[^}]*)?\}$/.exec(s)
  if (whole) return whole[1]
  if (s.includes('${')) return undefined // an interpolation embedded in text: no single default
  return s
}

function pairs(v: unknown): [string, unknown][] {
  if (isRecord(v)) return Object.entries(v)
  if (Array.isArray(v)) {
    return v.map((item) => {
      const s = String(item)
      const at = s.indexOf('=')
      return at < 0 ? [s, undefined] : [s.slice(0, at), s.slice(at + 1)]
    })
  }
  return []
}

export function parseCompose(text: string): ComposeModel {
  const doc: unknown = parse(text, { merge: true })
  if (!isRecord(doc) || !isRecord(doc.services)) throw new Error('compose document has no services map')
  const services = new Map<string, ComposeService>()
  for (const [name, raw] of Object.entries(doc.services)) {
    const svc = isRecord(raw) ? raw : {}
    let postgresLabel: string | null = null
    for (const [k, v] of pairs(svc.labels)) if (k === COMPOSE_POSTGRES_LABEL) postgresLabel = scalar(v) ?? ''
    const env: Record<string, string | undefined> = {}
    for (const [k, v] of pairs(svc.environment)) env[k] = composeDefault(v)
    services.set(name, { name, postgresLabel, env })
  }
  return { services }
}

export function readCompose(path: string): ComposeModel {
  return parseCompose(readFileSync(path, 'utf8'))
}
