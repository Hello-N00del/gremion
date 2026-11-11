// image-step.sh runs inside the image build. The rule it keeps: it NEVER exits non-zero, and it ALWAYS leaves a
// valid status.json. These tests run it against a temp copy of this folder with a fake extractor.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHA2 = 'fedcba9876543210fedcba9876543210fedcba98'
const posix = (p) => p.replace(/\\/g, '/')
const sh = spawnSync('sh', ['-c', 'exit 0'])
const hasSh = !sh.error

const EXTRACT_FAIL = 'console.error("boom: /secret/path/stack"); process.exit(3)\n'
// a fake extractor that writes a tiny valid graph to the --out it is given
const EXTRACT_OK = `
import fs from 'node:fs'
import path from 'node:path'
const out = process.argv[process.argv.indexOf('--out') + 1]
const layer = (l) => ({ id: 'L' + l, kind: 'layer', name: 'L' + l, parent: null, file: '', line: 0, layer: 'L' + l })
const nodes = [0, 1, 2, 3, 4, 5].map(layer)
nodes.push({ id: 'fn:a.ts#f@1', kind: 'function', name: 'f', parent: 'L3', file: 'a.ts', line: 1, layer: 'L3' })
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ meta: { commit: 'x', resolvedRatioPercent: 50 }, nodes, edges: [] }))
`

describe.skipIf(!hasSh)('image-step.sh', () => {
  let root, tool, src, out
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-image-'))
    tool = path.join(root, 'codemap')
    fs.mkdirSync(tool)
    for (const f of fs.readdirSync(HERE)) if (!f.endsWith('.test.mjs') && fs.statSync(path.join(HERE, f)).isFile()) fs.copyFileSync(path.join(HERE, f), path.join(tool, f))
    src = path.join(root, 'src')
    out = path.join(root, 'out')
    fs.mkdirSync(path.join(src, '.git', 'refs', 'heads'), { recursive: true })
    fs.mkdirSync(out)
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const run = (env = {}, args = [posix(src), posix(out), posix(root)]) =>
    spawnSync('sh', [posix(path.join(tool, 'image-step.sh')), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 })
  const status = () => JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'))
  const setExtract = (code) => fs.writeFileSync(path.join(tool, 'extract.mjs'), code)
  const head = (s) => fs.writeFileSync(path.join(src, '.git', 'HEAD'), s)

  it('a failing extractor: exit 0, a valid status.json with a fixed reason, the commit, no graph and no page', () => {
    head(SHA + '\n')
    setExtract(EXTRACT_FAIL)
    const r = run()
    expect(r.status).toBe(0)
    expect(status()).toEqual({ ok: false, commit: SHA, generatedFor: 'unavailable', counts: { functions: 0, connections: 0 }, staleSteps: [], staleAreas: [], undescribedAreas: [], reason: 'extract failed (exit 3)' })
    expect(fs.existsSync(path.join(out, 'graph.json'))).toBe(false)
    expect(fs.existsSync(path.join(out, 'code-map.html'))).toBe(false)
    expect(JSON.stringify(status())).not.toContain('secret')
  })

  it('an extractor that is not there is an extract failure, not a crash', () => {
    fs.rmSync(path.join(tool, 'extract.mjs'))
    const r = run()
    expect(r.status).toBe(0)
    expect(status().reason).toBe('extract failed (exit 1)')
  })

  it('an extractor that runs too long is killed: extract timed out', () => {
    setExtract('setTimeout(() => {}, 60000)\n')
    const t0 = Date.now()
    const r = run({ CODEMAP_TIMEOUT_SECONDS: '2' })
    expect(r.status).toBe(0)
    expect(status()).toMatchObject({ ok: false, reason: 'extract timed out' })
    expect(Date.now() - t0).toBeLessThan(30000)
  })

  it('a build that fails: build failed (exit N), the graph and a partial page are removed', () => {
    setExtract(EXTRACT_OK)
    fs.writeFileSync(path.join(tool, 'build.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.argv[process.argv.indexOf("--out-dir") + 1] + "/code-map.html", "partial"); process.exit(5)\n')
    const r = run()
    expect(r.status).toBe(0)
    expect(status()).toMatchObject({ ok: false, reason: 'build failed (exit 5)' })
    expect(fs.existsSync(path.join(out, 'graph.json'))).toBe(false)
    expect(fs.existsSync(path.join(out, 'code-map.html'))).toBe(false)
  })

  it('a build that exits 0 and writes no status is still a failure with a status', () => {
    setExtract(EXTRACT_OK)
    fs.writeFileSync(path.join(tool, 'build.mjs'), 'process.exit(0)\n')
    expect(run().status).toBe(0)
    expect(status()).toMatchObject({ ok: false, reason: 'build failed (no status)' })
  })

  it('the whole path: ok status, the page, and the graph is deleted', () => {
    head(SHA2 + '\n')
    setExtract(EXTRACT_OK)
    const r = run()
    expect(r.status).toBe(0)
    expect(status()).toMatchObject({ ok: true, commit: SHA2, reason: null })
    expect(fs.existsSync(path.join(out, 'code-map.html'))).toBe(true)
    expect(fs.existsSync(path.join(out, 'graph.json'))).toBe(false)
  })

  it('no arguments and a missing output folder never exit non-zero', () => {
    expect(run({}, []).status).toBe(0)
    const r = run({}, [posix(src), posix(path.join(root, 'new', 'deeper', 'out')), posix(root)])
    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(root, 'new', 'deeper', 'out', 'status.json'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('node that cannot start still leaves a status', () => {
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
    const r = run({ PATH: `${bin}:${process.env.PATH}` })
    expect(r.status).toBe(0)
    expect(status()).toMatchObject({ ok: false, reason: 'extract failed (exit 127)' })
  })

  describe('the commit, read without git', () => {
    const commitOf = () => {
      setExtract(EXTRACT_FAIL)
      expect(run().status).toBe(0)
      return status().commit
    }
    it('a detached HEAD holding a sha (git clone --depth 1 --branch <tag>)', () => {
      head(SHA + '\n')
      expect(commitOf()).toBe(SHA)
    })
    it('a branch HEAD resolved through a loose ref', () => {
      head('ref: refs/heads/main\n')
      fs.writeFileSync(path.join(src, '.git', 'refs', 'heads', 'main'), SHA2 + '\n')
      expect(commitOf()).toBe(SHA2)
    })
    it('a branch HEAD resolved through packed-refs', () => {
      head('ref: refs/heads/main\n')
      fs.writeFileSync(path.join(src, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/other\n${SHA2} refs/heads/main\n`)
      expect(commitOf()).toBe(SHA2)
    })
    it('a CRLF HEAD is read', () => {
      head(SHA + '\r\n')
      expect(commitOf()).toBe(SHA)
    })
    it('no .git folder reads unknown', () => {
      fs.rmSync(path.join(src, '.git'), { recursive: true })
      expect(commitOf()).toBe('unknown')
    })
    it('a ref that resolves to nothing reads unknown', () => {
      head('ref: refs/heads/gone\n')
      expect(commitOf()).toBe('unknown')
    })
    it.each([['garbage', 'not a sha at all\n'], ['short', 'abc123\n'], ['upper case', SHA.toUpperCase() + '\n'], ['empty', ''], ['too long', SHA + 'a\n']])('%s reads unknown', (_n, text) => {
      head(text)
      expect(commitOf()).toBe('unknown')
    })
    it('a ref that climbs out of .git reads unknown', () => {
      fs.writeFileSync(path.join(root, 'outside'), SHA + '\n')
      head('ref: refs/../../../outside\n')
      expect(commitOf()).toBe('unknown')
    })
    it('a loose ref that holds garbage reads unknown', () => {
      head('ref: refs/heads/main\n')
      fs.writeFileSync(path.join(src, '.git', 'refs', 'heads', 'main'), 'zzz\n')
      expect(commitOf()).toBe('unknown')
    })
  })

  it('the script is POSIX sh: no bashism that busybox ash would refuse', () => {
    const s = fs.readFileSync(path.join(HERE, 'image-step.sh'), 'utf8')
    expect(s.split('\n')[0]).toBe('#!/bin/sh')
    const code = s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toMatch(/\[\[|\bfunction\s+\w+\s*\(|<\(|\bsource\b|\blocal\b|\bset -e\b|\bset -u\b/)
  })
})
