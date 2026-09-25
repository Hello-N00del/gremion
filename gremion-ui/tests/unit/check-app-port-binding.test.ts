// @vitest-environment node
//
// TASK-028 (TRD-099): a working copy that has not been set up must fail the
// app-port binding check and the hygiene check's g2 with "run setup first" --
// never with a security-invariant failure it did not measure. And the
// setup-first answer must fire ONLY on absent files: a real non-loopback
// binding in a set-up working copy is still a FAIL.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { main } from '../../scripts/check-app-port-binding.mjs'
import { missingLocalEnvFiles, LOCAL_ENV_FILES, SETUP_FIRST } from '../../../scripts/env/local-setup.mjs'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const PORT_CHECK = path.join(REPO_ROOT, 'gremion-ui', 'scripts', 'check-app-port-binding.mjs')
const HYGIENE = path.join(REPO_ROOT, 'scripts', 'kernel-hygiene-check.mjs')
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.override.yml', 'docker-compose.prod.yml']

const dockerUp = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0

let tmp: string

/** A copy of the composition, with none of the local env files. */
function composeCopy(): string {
  for (const f of COMPOSE_FILES) cpSync(path.join(REPO_ROOT, f), path.join(tmp, f))
  return tmp
}

function runCli(script: string, root: string) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, GREMION_REPO_ROOT: root },
    timeout: 120_000,
  })
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'task028-setup-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('missingLocalEnvFiles (the D1 preflight)', () => {
  it('names both files on an empty tree, in declaration order', () => {
    expect(missingLocalEnvFiles(tmp)).toEqual(['.env', 'legal/legal.env'])
    expect(LOCAL_ENV_FILES).toEqual(['.env', 'legal/legal.env'])
  })

  it('names only legal/legal.env when .env exists', () => {
    writeFileSync(path.join(tmp, '.env'), 'A=1\n')
    expect(missingLocalEnvFiles(tmp)).toEqual(['legal/legal.env'])
  })

  it('is empty once both files exist (an EMPTY file is present, not absent)', () => {
    writeFileSync(path.join(tmp, '.env'), '')
    mkdirSync(path.join(tmp, 'legal'))
    writeFileSync(path.join(tmp, 'legal', 'legal.env'), '')
    expect(missingLocalEnvFiles(tmp)).toEqual([])
  })

  it('does NOT call a directory at .env absent -- that is broken, not un-set-up', () => {
    mkdirSync(path.join(tmp, '.env'))
    expect(missingLocalEnvFiles(tmp)).not.toContain('.env')
  })

  it('treats a dangling symlink as absent', () => {
    symlinkSync(path.join(tmp, 'nowhere'), path.join(tmp, '.env'))
    expect(missingLocalEnvFiles(tmp)).toContain('.env')
  })

  it('refuses an empty root instead of answering for the cwd', () => {
    expect(() => missingLocalEnvFiles('')).toThrow(/root/)
  })
})

describe('check-app-port-binding on a working copy that is not set up', () => {
  it('main() returns non-zero with the setup-first text and no security finding', () => {
    const root = composeCopy()
    writeFileSync(path.join(root, '.env'), 'A=1\n') // .env present, legal/legal.env absent
    const lines: string[] = []
    const orig = { error: console.error, warn: console.warn, info: console.info }
    console.error = console.warn = console.info = (...a: unknown[]) => void lines.push(a.join(' '))
    let rc: number
    try {
      rc = main({ root })
    } finally {
      Object.assign(console, orig)
    }
    const out = lines.join('\n')
    expect(rc).not.toBe(0)
    expect(out).toContain(SETUP_FIRST)
    expect(out).toContain('legal/legal.env')
    expect(out).not.toContain('non-loopback')
    expect(out).not.toContain('SAFETY')
  })

  it('the CLI exits non-zero with the setup-first text (GREMION_REPO_ROOT override)', () => {
    const res = runCli(PORT_CHECK, composeCopy())
    const out = `${res.stdout}${res.stderr}`
    expect(res.status).not.toBe(0)
    expect(out).toContain(SETUP_FIRST)
    expect(out).not.toContain('non-loopback')
    expect(out).not.toContain('SAFETY')
  })

  it('importing the script runs nothing (import-safe main)', async () => {
    // The import at the top of this file would already have exited the
    // worker if the module ran main() on import; re-importing must be inert.
    const mod = await import('../../scripts/check-app-port-binding.mjs')
    expect(typeof mod.main).toBe('function')
  })
})

describe.skipIf(!dockerUp)('check-app-port-binding on a SET-UP working copy (needs docker)', () => {
  it('a real 0.0.0.0 publish is still a FAIL, not a setup-first message', () => {
    const root = composeCopy()
    cpSync(path.join(REPO_ROOT, '.env.example'), path.join(root, '.env'))
    mkdirSync(path.join(root, 'legal'))
    writeFileSync(path.join(root, 'legal', 'legal.env'), '')
    // Publish gremion-ui on every interface in the dev file set.
    writeFileSync(
      path.join(root, 'docker-compose.override.yml'),
      'services:\n  gremion-ui:\n    ports:\n      - "3999:3000"\n',
    )
    const res = runCli(PORT_CHECK, root)
    const out = `${res.stdout}${res.stderr}`
    expect(res.status).toBe(1)
    expect(out).toContain('non-loopback')
    expect(out).not.toContain(SETUP_FIRST)
  })
})

describe('kernel-hygiene g2 on a working copy that is not set up', () => {
  it('reports the dev overlay as NOT CHECKED with the setup-first text, before any render', () => {
    // A fresh clone of this repository: exactly what a new contributor has.
    const clone = path.join(tmp, 'clone')
    const cl = spawnSync('git', ['clone', '-q', '--shared', REPO_ROOT, clone], { encoding: 'utf8' })
    expect(cl.status, cl.stderr).toBe(0)
    expect(missingLocalEnvFiles(clone)).toEqual(['.env', 'legal/legal.env'])
    // PATH without kubectl: the preflight must answer before a render is tried,
    // so the verdict cannot depend on whether kustomize is installed.
    const res = spawnSync(process.execPath, [HYGIENE], {
      encoding: 'utf8',
      env: { ...process.env, GREMION_REPO_ROOT: clone, PATH: path.dirname(process.execPath) },
      timeout: 120_000,
    })
    const out = `${res.stdout}${res.stderr}`
    const g2 = out.split('\n').find((l) => l.includes('✗ g2 ')) ?? ''
    expect(res.status).not.toBe(0)
    expect(g2).toMatch(/dev: NOT CHECKED/)
    expect(g2).toContain(SETUP_FIRST)
    expect(g2).toContain('.env')
    expect(g2).not.toMatch(/dev: render FAILED/)
    expect(out).not.toContain('non-loopback')
    expect(out).not.toContain('SAFETY')
  })
})
