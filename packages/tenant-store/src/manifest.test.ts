import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MigrationManifestError, readVerifiedMigrations } from './manifest.js'

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function dir(files: Record<string, string>, manifest: Record<string, string> | string | null) {
  const d = mkdtempSync(join(tmpdir(), 't020-manifest-'))
  dirs.push(d)
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t)
  if (manifest !== null) writeFileSync(join(d, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return d
}

const F1 = 'CREATE TABLE a (id int);\n'
const F2 = 'CREATE TABLE b (id int);\n'

function codeOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(MigrationManifestError)
    return (e as MigrationManifestError).problems.map((p) => `${p.code}:${p.file ?? ''}`)
  }
  throw new Error('expected a MigrationManifestError')
}

describe('readVerifiedMigrations', () => {
  it('returns every file in filename order with its sha256 and text', () => {
    const d = dir({ '002_b.sql': F2, '001_a.sql': F1, 'README.md': 'x' }, { '001_a.sql': sha(F1), '002_b.sql': sha(F2) })
    expect(readVerifiedMigrations(d)).toEqual([
      { file: '001_a.sql', sha256: sha(F1), text: F1 },
      { file: '002_b.sql', sha256: sha(F2), text: F2 },
    ])
  })

  it('fails on one changed byte, naming the file', () => {
    const d = dir({ '001_a.sql': F1.replace('a', 'c') }, { '001_a.sql': sha(F1) })
    expect(codeOf(() => readVerifiedMigrations(d))).toEqual(['HASH_MISMATCH:001_a.sql'])
  })

  it('fails on a file with no manifest entry', () => {
    const d = dir({ '001_a.sql': F1, '002_b.sql': F2 }, { '001_a.sql': sha(F1) })
    expect(codeOf(() => readVerifiedMigrations(d))).toEqual(['FILE_NOT_IN_MANIFEST:002_b.sql'])
  })

  it('fails on a manifest entry with no file', () => {
    const d = dir({ '001_a.sql': F1 }, { '001_a.sql': sha(F1), '002_b.sql': sha(F2) })
    expect(codeOf(() => readVerifiedMigrations(d))).toEqual(['MANIFEST_ENTRY_WITHOUT_FILE:002_b.sql'])
  })

  it('reports every problem at once, not just the first', () => {
    const d = dir({ '001_a.sql': 'x', '003_c.sql': F1 }, { '001_a.sql': sha(F1), '002_b.sql': sha(F2) })
    expect(codeOf(() => readVerifiedMigrations(d)).sort()).toEqual([
      'FILE_NOT_IN_MANIFEST:003_c.sql',
      'HASH_MISMATCH:001_a.sql',
      'MANIFEST_ENTRY_WITHOUT_FILE:002_b.sql',
    ])
  })

  it('fails closed on a missing or malformed manifest', () => {
    expect(codeOf(() => readVerifiedMigrations(dir({ '001_a.sql': F1 }, null)))).toEqual(['MANIFEST_UNREADABLE:'])
    expect(codeOf(() => readVerifiedMigrations(dir({ '001_a.sql': F1 }, '{')))).toEqual(['MANIFEST_MALFORMED:'])
    expect(codeOf(() => readVerifiedMigrations(dir({ '001_a.sql': F1 }, '[]')))).toEqual(['MANIFEST_MALFORMED:'])
    expect(codeOf(() => readVerifiedMigrations(dir({ '001_a.sql': F1 }, { '001_a.sql': 'abc' })))).toEqual(['MANIFEST_MALFORMED:001_a.sql'])
  })

  it('refuses a manifest key that is not a plain *.sql filename (no path traversal)', () => {
    const d = dir({ '001_a.sql': F1 }, { '001_a.sql': sha(F1), '../evil.sql': sha(F1) })
    expect(codeOf(() => readVerifiedMigrations(d))).toEqual(['MANIFEST_MALFORMED:../evil.sql'])
  })

  it('fails on an empty migration set rather than passing vacuously', () => {
    expect(codeOf(() => readVerifiedMigrations(dir({}, {})))).toEqual(['NO_MIGRATIONS:'])
  })

  it('refuses bytes that are not valid UTF-8', () => {
    const bad = Buffer.from([0x53, 0xff, 0x3b])
    const d = dir({}, { '001_a.sql': sha(bad) })
    writeFileSync(join(d, '001_a.sql'), bad)
    expect(codeOf(() => readVerifiedMigrations(d))).toEqual(['NOT_UTF8:001_a.sql'])
  })

  it('reads the manifest format the kernel builder writes (TRD-353): the real control set verifies', () => {
    const real = new URL('../../../gremion-ui/migrations-control/', import.meta.url)
    expect(readVerifiedMigrations(fileURLToPath(real)).map((m) => m.file)).toContain('006_boundary_ids_uuidv7.sql')
  })
})
