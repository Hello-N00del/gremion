// The kernel is public and brand-blind; a vertical is DATA that lives under
// `verticals/` at the repo root. The ONE carve-out of the vertical-literal
// boundary is that prefix: `verticals/**` may name its vertical, everything
// else may not. These tests prove (1) the import code stays outside the
// vertical's vocabulary, (2) the carve-out is real (the data does carry the
// words) and exactly that wide, (3) a seeded violation outside `verticals/`
// still fails, (4) vertical data never carries the product name or an
// institution identity.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, VERTICAL_LITERALS, sourceFiles, verticalLiteralOffenders } from './helpers.ts'

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')
const posix = (p: string): string => p.replaceAll(String.fromCharCode(92), '/')

/** Every tracked-shaped file under a repo-relative directory. */
function filesUnder(rel: string): string[] {
  const abs = join(REPO_ROOT, rel)
  if (!existsSync(abs)) return []
  return readdirSync(abs).flatMap((n) => {
    const child = `${rel}/${n}`
    return statSync(join(REPO_ROOT, child)).isDirectory() ? filesUnder(child) : [child]
  })
}

const IMPORT_CODE = [
  ...sourceFiles(join(REPO_ROOT, 'packages', 'member-import', 'src')).map((p) => posix(p.slice(REPO_ROOT.length + 1))),
  'gremion-ui/src/lib/server/tenant/provisioner/member-import-adapters.ts',
  'gremion-ui/scripts/tenant-provision-import.ts',
  'infra/host/lib/executor/handlers/import_members.sh',
  'infra/host/lib/executor/handlers/seed_vertical.sh',
]
const VERTICAL_DATA = filesUnder('verticals').filter((f) => f.startsWith('verticals/stura/'))

describe('vertical-literal boundary: only verticals/** may name a vertical', () => {
  it('scans real files (not vacuous): the import code and the stura data are both found', () => {
    expect(IMPORT_CODE.length).toBeGreaterThan(8)
    expect(VERTICAL_DATA.map((f) => f.split('/').pop()).sort()).toEqual(['README.md', 'blueprint.json', 'roles.json', 'vertical.json', 'wording.de.json'])
  })

  it('the import code names no vertical', () => {
    expect(verticalLiteralOffenders(IMPORT_CODE, read)).toEqual([])
  })

  it('the carve-out is exercised and exactly verticals/**: the data carries the words, and only the prefix exempts them', () => {
    const carrying = VERTICAL_DATA.filter((f) => new RegExp(VERTICAL_LITERALS, 'i').test(read(f)))
    expect(carrying.length).toBeGreaterThan(0)
    expect(verticalLiteralOffenders(VERTICAL_DATA, read)).toEqual([])
    // the same files one directory over (no carve-out) are offenders
    const moved = carrying.map((f) => f.replace(/^verticals\//, 'elsewhere/'))
    expect(verticalLiteralOffenders(moved, (rel) => read(rel.replace(/^elsewhere\//, 'verticals/')))).toEqual(moved)
  })

  it('a seeded vertical word in kernel code outside verticals/ still fails; look-alike prefixes are not exempt', () => {
    const seeded = new Map<string, string>([
      ['packages/member-import/src/apply.ts', 'const x = "Studierendenrat"'],
      ['gremion-ui/src/lib/x.ts', '// Referat Finanzen'],
      ['verticals-extra/stura/blueprint.json', '{"name":"Studierendenrat"}'],
      ['src/verticals/stura.ts', 'export const v = "stura"'],
      ['verticals/stura/blueprint.json', '{"name":"Studierendenrat"}'],
    ])
    const bad = verticalLiteralOffenders([...seeded.keys()], (rel) => seeded.get(rel)!)
    expect(bad).toEqual(['packages/member-import/src/apply.ts', 'gremion-ui/src/lib/x.ts', 'verticals-extra/stura/blueprint.json', 'src/verticals/stura.ts'])
  })

  it('vertical data never carries the product name, an institution identity, a host or an address', () => {
    for (const f of VERTICAL_DATA) {
      const text = read(f)
      expect(text, f).not.toMatch(/StuRaOS|sturaos|HS Harz|Hochschule Harz|hs-harz\.de|StuFis/i)
      expect(text, f).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}|https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b/i)
    }
  })
})
