// No seed in clear (TRD-442): a plaintext seed force-added under secrets/nats
// fails check-sops; every path this package and its proof write is ignored by
// git; no *.nk file is tracked.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createUser } from '@nats-io/nkeys'
// @ts-expect-error -- untyped .mjs guard
import { runSopsCheck } from '../../../scripts/release/check-sops.mjs'

const REPO = path.resolve(import.meta.dirname, '../../..')
const TREE = path.join(REPO, `.scratch/t024/unit/sops-tree-${process.pid}`)
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args]).toString()
afterAll(() => rmSync(TREE, { recursive: true, force: true }))

type Problem = { code: string; path: string; message: string }

describe('no seed in clear', () => {
  test('a force-added plaintext secrets/nats/finance/tenant_x.nk fails check-sops (control: clean without it)', () => {
    rmSync(TREE, { recursive: true, force: true })
    mkdirSync(path.join(TREE, 'scripts/release'), { recursive: true })
    git(TREE, 'init', '-q')
    copyFileSync(path.join(REPO, '.sops.yaml'), path.join(TREE, '.sops.yaml'))
    copyFileSync(path.join(REPO, '.gitignore'), path.join(TREE, '.gitignore'))
    writeFileSync(path.join(TREE, 'README.md'), 'scratch\n')
    git(TREE, 'add', '.sops.yaml', '.gitignore', 'README.md')
    const before = runSopsCheck(TREE) as { problems: Problem[]; secretFiles: number }
    expect(before.problems.filter((p) => p.path.includes('secrets/nats'))).toEqual([])

    const f = 'secrets/nats/finance/tenant_x.nk'
    mkdirSync(path.join(TREE, 'secrets/nats/finance'), { recursive: true })
    writeFileSync(path.join(TREE, f), `${new TextDecoder().decode(createUser().getSeed())}\n`, { mode: 0o600 })
    // the ignore rule holds: a plain add refuses it BECAUSE it is ignored
    // (git's own reason on stderr, not merely a failed command -- a missing
    // file or a broken repo fails too, and proves nothing about the rule)...
    const plain = spawnSync('git', ['-C', TREE, 'add', f], { encoding: 'utf8' })
    expect(plain.status, plain.stderr).toBe(1)
    expect(plain.stderr).toMatch(/paths are ignored by one of your \.gitignore files:\s+secrets\/?/)
    expect(git(TREE, 'ls-files', f).trim(), 'the plain add staged the seed').toBe('')
    // ...a force-add is what check-sops must catch
    git(TREE, 'add', '-f', f)
    const after = runSopsCheck(TREE) as { problems: Problem[]; secretFiles: number }
    expect(after.secretFiles).toBe(1)
    expect(after.problems.some((p) => p.path === f), JSON.stringify(after.problems)).toBe(true)
  })

  test('every path ensureTenantAccount (dev/scratch) and proof.sh write is git-ignored', () => {
    const paths = [
      'secrets/nats/_sys/reload.nk',
      'secrets/nats/_admin/tenant_ta.nk',
      'secrets/nats/kernel/tenant_ta.nk',
      'secrets/nats/finance/tenant_ta.nk.tmp-1-abcd',
      '.scratch/t024/proof-auth/secrets/nats/_sys/reload.nk',
      '.scratch/t024/proof-auth/secrets/nats/publishing/tenant_ta.nk',
      '.scratch/t024/proof-auth/accounts/accounts.conf',
      '.scratch/t024/proof-auth/accounts/.loaded.sha256',
      '.scratch/t024/proof-open/vitest.log',
      '.scratch/t024/unit/case-1/secrets/nats/kernel/tenant_ta.nk',
    ]
    for (const p of paths) {
      // --no-index: the rules alone, whatever this checkout's index holds
      expect(() => git(REPO, 'check-ignore', '-q', '--no-index', p), p).not.toThrow()
    }
  })

  test('no *.nk file is tracked', () => {
    expect(git(REPO, 'ls-files', '*.nk', '**/*.nk').trim()).toBe('')
  })
})
