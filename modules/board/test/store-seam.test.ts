// modules/board/test/store-seam.test.ts
//
// R29-BOARD-STORE-K A1: the board leaf reaches a tenant's database ONLY through
// @gremion/tenant-store (openTenantDb behind one schemaGate). A source scan of
// src/** that fails on each rule:
//   1. no single-DB accessor or request-path migration tokens: getStore,
//      BOARD_PG_URL (the bare, pre-D13 variable), runMigrations, a postgres( call;
//   2. no VALUE import of the `postgres` driver (the Sql type comes from
//      @gremion/tenant-store through a type-only import);
//   3. import.meta.url only in depth-1 files (src/*.ts): esbuild bundles the leaf
//      into ONE depth-1 file (dist/index.js), so a path resolved from a deeper
//      source file is right from the tree and wrong from the bundle (the
//      bundle-depth rule, formerly recorded in src/migrations.ts).
// PG-free: part of the unit suite.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(__dirname, '..', 'src')

/** Blanks // and /* *\/ comments (a // preceded by ':' or a quote, as in a url, is kept). */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

const FORBIDDEN_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
  ['getStore', /\bgetStore\b/],
  ['BOARD_PG_URL', /\bBOARD_PG_URL\b/],
  ['runMigrations', /\brunMigrations\b/],
  ['postgres( call', /\bpostgres\s*\(/],
]

const POSTGRES_VALUE_IMPORT: readonly RegExp[] = [
  // import X from 'postgres' / import * as X / import { a } — `import type` excluded
  /\bimport\s+(?!type\b)[^;'"`]*?\bfrom\s*['"`]postgres(?:\/[^'"`]*)?['"`]/,
  /\bexport\s+(?!type\b)[^;'"`]*?\bfrom\s*['"`]postgres(?:\/[^'"`]*)?['"`]/,
  /\bimport\s*['"`]postgres(?:\/[^'"`]*)?['"`]/,
  /\b(?:require|import)\s*\(\s*['"`]postgres(?:\/[^'"`]*)?['"`]\s*\)/,
]

export interface SeamFinding {
  file: string
  rule: string
}

/** Scans one source file's text; `rel` is its path relative to src/, '/'-separated. */
export function scanSource(rel: string, text: string): SeamFinding[] {
  const code = stripComments(text)
  const out: SeamFinding[] = []
  for (const [name, re] of FORBIDDEN_TOKENS) if (re.test(code)) out.push({ file: rel, rule: `token ${name}` })
  if (POSTGRES_VALUE_IMPORT.some((re) => re.test(code))) out.push({ file: rel, rule: 'value import of postgres' })
  if (rel.includes('/') && /\bimport\.meta\.url\b/.test(code)) out.push({ file: rel, rule: 'import.meta.url below depth 1' })
  return out
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile() && e.name.endsWith('.ts')) yield p
  }
}

const files = [...walk(SRC)].map((abs) => ({
  rel: path.relative(SRC, abs).split(path.sep).join('/'),
  text: fs.readFileSync(abs, 'utf-8'),
}))

describe('store seam scanner (self-test)', () => {
  it('flags each forbidden token', () => {
    expect(scanSource('a.ts', 'const s = await getStore()').map((f) => f.rule)).toContain('token getStore')
    expect(scanSource('a.ts', 'process.env.BOARD_PG_URL').map((f) => f.rule)).toContain('token BOARD_PG_URL')
    expect(scanSource('a.ts', 'await runMigrations(url)').map((f) => f.rule)).toContain('token runMigrations')
    expect(scanSource('a.ts', 'const p = postgres (url)').map((f) => f.rule)).toContain('token postgres( call')
  })

  it('does not flag the per-(tenant, module) variable GREMION_BOARD_PG_URL', () => {
    expect(scanSource('a.ts', "const v = 'GREMION_BOARD_PG_URL'")).toEqual([])
  })

  it('flags a value import of postgres in every form and passes a type-only one', () => {
    for (const src of [
      "import postgres from 'postgres'",
      'import * as pg from "postgres"',
      "import { default as pg } from 'postgres'",
      "export { default } from 'postgres'",
      "import 'postgres'",
      "const pg = await import('postgres')",
      "const pg = require('postgres')",
    ]) {
      expect(scanSource('a.ts', src).map((f) => f.rule), src).toContain('value import of postgres')
    }
    expect(scanSource('a.ts', "import type postgres from 'postgres'")).toEqual([])
    expect(scanSource('a.ts', "import type { TenantStore } from '@gremion/tenant-store'")).toEqual([])
  })

  it('flags import.meta.url below depth 1 only', () => {
    expect(scanSource('app.ts', 'fileURLToPath(import.meta.url)')).toEqual([])
    expect(scanSource('store/tenant-db.ts', 'fileURLToPath(import.meta.url)').map((f) => f.rule)).toContain(
      'import.meta.url below depth 1',
    )
    expect(scanSource('http/x.ts', 'import.meta.url').map((f) => f.rule)).toContain('import.meta.url below depth 1')
  })

  it('ignores tokens that sit only in comments, and keeps code after a url string', () => {
    expect(scanSource('a.ts', '// no getStore here\n/* runMigrations */ const x = 1')).toEqual([])
    expect(scanSource('a.ts', "new URL(u, 'http://internal'); getStore()").map((f) => f.rule)).toContain('token getStore')
  })
})

describe('board leaf src/** — the tenant-store seam (A1)', () => {
  it('scans a non-empty source tree (not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(6)
    expect(files.map((f) => f.rel)).toEqual(expect.arrayContaining(['app.ts', 'index.ts', 'store/index.ts', 'store/tenant-db.ts']))
  })

  it('no file carries a single-DB token, a postgres value import, or a deep import.meta.url', () => {
    const findings = files.flatMap((f) => scanSource(f.rel, f.text))
    expect(findings, findings.map((f) => `${f.file}: ${f.rule}`).join('\n')).toEqual([])
  })

  it('MIGRATIONS_DIR is resolved in the depth-1 src/app.ts (one ..)', () => {
    const app = files.find((f) => f.rel === 'app.ts')
    expect(app, 'src/app.ts is missing').toBeDefined()
    expect(stripComments(app!.text)).toMatch(
      /export const MIGRATIONS_DIR = path\.join\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', 'migrations'\)/,
    )
  })
})
