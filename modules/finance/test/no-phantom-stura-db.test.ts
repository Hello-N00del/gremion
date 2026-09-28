/**
 * no-phantom-stura-db — the finance leaf must NEVER resolve a `stura_*` database
 * name.
 *
 * Regression guard for the open-core carve incident (a carved compose once hit
 * the LIVE staging PG via a hardcoded `stura_*` name). The finance leaf owns its
 * OWN databases: `finance_<slug>` (+ `finance_control`), or `finance_test_*` in
 * tests; the backfill SOURCE is the kernel `t_<slug>` DB. No code path may build
 * a `stura_*` / `stura-*` database identifier.
 *
 * Also pins that the leaf declares no phantom `@gremion/db` dependency — it is
 * self-contained (node:http + postgres only).
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DB_PREFIX } from '../src/tenant-store.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_ROOT = path.resolve(__dirname, '..')

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e)
    if (fs.statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.ts')) yield p
  }
}

/** Strip block + line comments so only executable code is scanned. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('no-phantom-stura-db — finance leaf never resolves a stura_* DB name', () => {
  it('the default production DB prefix is finance_ (never stura_)', () => {
    expect(DEFAULT_DB_PREFIX).toBe('finance_')
    expect(DEFAULT_DB_PREFIX.startsWith('stura')).toBe(false)
  })

  it('no executable code in src/ or scripts/ references a stura database identifier', () => {
    const offenders: string[] = []
    for (const dir of ['src', 'scripts']) {
      for (const abs of walk(path.join(SERVICE_ROOT, dir))) {
        const code = stripComments(fs.readFileSync(abs, 'utf-8'))
        if (/stura/i.test(code)) {
          offenders.push(path.relative(SERVICE_ROOT, abs))
        }
      }
    }
    expect(offenders, `stura reference in executable code: ${offenders.join(', ')}`).toEqual([])
  })

  it('the DB-name builders resolve finance_<slug> targets + a t_<slug> source', () => {
    const store = fs.readFileSync(path.join(SERVICE_ROOT, 'src/tenant-store.ts'), 'utf-8')
    const backfill = fs.readFileSync(path.join(SERVICE_ROOT, 'scripts/backfill.ts'), 'utf-8')
    // Target DB name = dbPrefix + slug, dbPrefix defaulting to finance_.
    expect(store).toContain("'finance_'")
    expect(store).toContain('dbPrefix + tenant.slug')
    // Backfill source defaults to the kernel t_<slug> DB, never stura_*.
    expect(backfill).toContain("'t_' + tenant")
    expect(backfill).toContain("opts.dbPrefix ?? 'finance_'")
  })

  it('package.json declares no phantom @gremion/db dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(Object.keys(allDeps)).not.toContain('@gremion/db')
  })
})
