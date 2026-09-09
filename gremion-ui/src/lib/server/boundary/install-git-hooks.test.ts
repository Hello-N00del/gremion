// gremion-ui/src/lib/server/boundary/install-git-hooks.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// Established pattern: unit test imports a scripts/*.mjs module directly
// (precedent: check-tenant-env-guard.mjs).
import { installHooks, MARKER_BEGIN } from '../../../../scripts/install-git-hooks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const gremionUiRoot = join(here, '../../../..')
let hooksDir: string
beforeEach(() => { hooksDir = mkdtempSync(join(tmpdir(), 'hooks-')) })

describe('installHooks', () => {
  it('creates pre-commit in an empty hooks dir', () => {
    const r = installHooks({ hooksDir, gremionUiRoot })
    expect(r.action).toBe('created')
    const content = readFileSync(join(hooksDir, 'pre-commit'), 'utf8')
    expect(content).toContain(MARKER_BEGIN)
    expect(content).toContain('boundary-lint')
  })
  it('is idempotent (re-run = no duplicate block)', () => {
    installHooks({ hooksDir, gremionUiRoot })
    const r2 = installHooks({ hooksDir, gremionUiRoot })
    expect(r2.action).toBe('updated')
    const content = readFileSync(join(hooksDir, 'pre-commit'), 'utf8')
    expect(content.split(MARKER_BEGIN).length).toBe(2) // marker appears exactly once
  })
  it('preserves a foreign pre-commit by PREPENDING a guarded block', () => {
    // The block used to be appended. A foreign hook that ends in `exit 0`
    // (husky's shim, most hand-written hooks) then makes the managed block
    // unreachable while the installer reports success. Prepending is what makes
    // "the wrapper fails closed" true on this install path too; the fixture
    // ends in `exit 0` precisely so a revert to append cannot pass.
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho existing-hook\nexit 0\n')
    const r = installHooks({ hooksDir, gremionUiRoot })
    expect(r.action).toBe('prepended')
    const content = readFileSync(join(hooksDir, 'pre-commit'), 'utf8')
    expect(content).toContain('echo existing-hook')
    expect(content).toContain(MARKER_BEGIN)
    expect(content.startsWith('#!/bin/sh\n')).toBe(true)
    expect(
      content.indexOf(MARKER_BEGIN),
      'the managed block must come before the foreign body, or it never executes',
    ).toBeLessThan(content.indexOf('echo existing-hook'))
  })
})
