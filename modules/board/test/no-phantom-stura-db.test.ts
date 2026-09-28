// services/board/test/no-phantom-stura-db.test.ts
//
// The board leaf owns its OWN database (BOARD_PG_URL) and is fully
// self-contained: it depends on `postgres` + `zod` only — NOT on `@gremion/db`
// (the kernel database package) nor any other `@gremion/*` workspace package.
// This guard fails if a kernel-DB coupling ever creeps back into package.json or
// the Dockerfile, AND if any source file hardcodes a `stura_`-prefixed database
// name (which would let the leaf phantom-connect to the LIVE staging kernel DB —
// the exact smoke-incident the carve hit and this test's name warns against).
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_ROOT = path.resolve(__dirname, '..')

const pkg = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const dockerfile = fs.readFileSync(path.join(SERVICE_ROOT, 'Dockerfile'), 'utf-8')

function* walkSrc(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e)
    if (fs.statSync(p).isDirectory()) yield* walkSrc(p)
    else if (p.endsWith('.ts')) yield p
  }
}

describe('board leaf — no phantom kernel-DB coupling', () => {
  it('package.json declares no @gremion/db dependency', () => {
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(Object.keys(allDeps)).not.toContain('@gremion/db')
  })

  it('package.json declares no @gremion/* workspace coupling (the leaf is self-contained)', () => {
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(Object.keys(allDeps).filter((k) => k.startsWith('@gremion/'))).toEqual([])
  })

  it('Dockerfile references @gremion/db / packages/db nowhere', () => {
    expect(dockerfile).not.toContain('@gremion/db')
    expect(dockerfile).not.toMatch(/packages\/db/)
  })

  it('no source file hardcodes a `stura_`-prefixed (live kernel) database name', () => {
    const offenders: string[] = []
    for (const abs of walkSrc(path.join(SERVICE_ROOT, 'src'))) {
      if (/stura_/.test(fs.readFileSync(abs, 'utf-8'))) {
        offenders.push(path.relative(SERVICE_ROOT, abs))
      }
    }
    expect(offenders, `files hardcoding a stura_ DB name: ${offenders.join(', ')}`).toEqual([])
  })
})
