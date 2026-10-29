// TASK-080-a Q8: the kind catalogue is DATA tied to the vertical, and the
// substrate (src/bodies, src/outbox) names no deselectable module (M-OFF-2).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VENDOR_BODY_KINDS, VENDOR_KINDS, VERTICAL_UNIT_KINDS } from '../../src/bodies/kinds.ts'

const SERVICE = fileURLToPath(new URL('../../', import.meta.url))
const REPO = join(SERVICE, '..', '..')

describe('the vendor kind catalogue (Q8)', () => {
  it('holds the six body kinds of DOMAIN DB-IDT-BODY and nothing else at level body', () => {
    expect(VENDOR_BODY_KINDS.map((k) => k.kindKey).sort()).toEqual(['fachschaftsrat', 'initiative', 'referat', 'stupa', 'stura', 'verwaltung'])
    expect(VENDOR_BODY_KINDS.every((k) => k.level === 'body' && !k.isOrgan)).toBe(true) // is_organ only on level unit (org_unit_kind_is_organ_check)
  })

  it('covers every unit kind the stura vertical blueprint uses, so a vertical kind without a catalogue row fails here', () => {
    const blueprint = JSON.parse(readFileSync(join(REPO, 'verticals', 'stura', 'blueprint.json'), 'utf8')) as { orgUnits: { kind: string }[] }
    const used = [...new Set(blueprint.orgUnits.map((u) => u.kind))].sort()
    expect(used.length).toBeGreaterThan(0)
    expect(VERTICAL_UNIT_KINDS.map((k) => k.kindKey).sort()).toEqual(used)
  })

  it('every kind key satisfies org_unit_kind_kind_key_check, keys are unique, the initiative kind stays undecided (question 4)', () => {
    const keys = VENDOR_KINDS.map((k) => k.kindKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]{1,39}$/)
    expect(VENDOR_KINDS.find((k) => k.kindKey === 'initiative')).toMatchObject({ level: 'body', mayAdoptBeschluesse: 'undecided' })
  })
})

/** Source files under `dir` whose import / export / dynamic import names modules/**. */
export function moduleImports(dir: string): string[] {
  const hits: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|mjs|js)$/.test(e)) {
        const text = readFileSync(p, 'utf8')
        if (/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"][^'"]*(?:\/|^)modules\/[^'"]*['"]/.test(text) || /['"]@gremion\/module-[^'"]*['"]/.test(text)) hits.push(relative(dir, p))
      }
    }
  }
  walk(dir)
  return hits
}

describe('M-OFF-2: the identity substrate imports no deselectable module', () => {
  it('src/bodies and src/outbox contain no import from modules/** (and no @gremion/module-* package)', () => {
    expect(moduleImports(join(SERVICE, 'src', 'bodies'))).toEqual([])
    expect(moduleImports(join(SERVICE, 'src', 'outbox'))).toEqual([])
  })

  it('the scan sees a seeded import (guard 8): a relative modules/board import, a dynamic one and a module package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moff-'))
    try {
      mkdirSync(join(dir, 'x'))
      writeFileSync(join(dir, 'a.ts'), "import { card } from '../../modules/board/src/index.ts'\n")
      writeFileSync(join(dir, 'x', 'b.ts'), "const m = await import('../../../modules/calendar')\n")
      writeFileSync(join(dir, 'c.ts'), "import x from '@gremion/module-board'\n")
      writeFileSync(join(dir, 'ok.ts'), "import { enqueue } from '@gremion/events'\n// modules/board is only a word here\n")
      expect(moduleImports(dir).sort()).toEqual(['a.ts', 'c.ts', join('x', 'b.ts')].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
