// Dockerfile.dockerignore is the allow-list of the build context of the control panel image, which copies the
// whole repository into a builder layer. These tests apply the file the way BuildKit does (the last matching rule
// wins; a rule that matches a folder matches everything below it) and check that no secret-class file gets in.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const rules = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

// a glob to a regular expression: `**/` is any folders (or none), `*` is a part of one name, `?` is one character
function toRegex(glob) {
  let r = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { i++; r += '(?:.*/)?' } else r += '.*'
    } else if (c === '*') r += '[^/]*'
    else if (c === '?') r += '[^/]'
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${r}$`)
}

function included(ruleList, file) {
  const parts = file.split('/')
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  let inc = true
  for (const rule of ruleList) {
    const neg = rule.startsWith('!')
    const re = toRegex(neg ? rule.slice(1) : rule)
    if (prefixes.some((p) => re.test(p))) inc = neg
  }
  return inc
}

const real = rules(path.join(HERE, '..', 'Dockerfile.dockerignore'))

describe('Dockerfile.dockerignore', () => {
  it('lets the source folders in', () => {
    for (const f of ['apps/control-panel/src/a.ts', 'packages/x/index.ts', 'gremion-ui/src/b.ts', 'pnpm-lock.yaml', 'LICENSE', '.git/HEAD', '.git/refs/heads/main', '.git/packed-refs', 'k8s/base/a.yaml'])
      expect(included(real, f), f).toBe(true)
  })

  it('keeps out what is not listed, and the git config and objects', () => {
    for (const f of ['docs/a.md', 'secrets/a', '.env', 'TEST_USERS.md', '.git/config', '.git/objects/ab/cd'])
      expect(included(real, f), f).toBe(false)
  })

  it('keeps out every secret-class file, in any allowed folder', () => {
    const files = [
      'docker/livekit/livekit.prod.yaml',
      'k8s/overlays/production/secrets/live.yaml',
      'k8s/overlays/production/secrets/live.yml',
      'infra/secrets/nested',
      'apps/x/secrets/a',
      'apps/x/.env',
      'apps/x/.env.production',
      'apps/x/.env.prod',
      'apps/x/.env.staging',
      'apps/x/.env.local',
      'apps/x/web.env.local',
      'legal/legal.env',
      'docker/db.env',
      'apps/x/app.key',
      'apps/x/tls.pem',
      'ops/client.p12',
      'ops/client.pfx',
    ]
    for (const f of files) expect(included(real, f), f).toBe(false)
  })

  it('still lets in what has a similar name', () => {
    for (const f of ['apps/x/secrets.ts', 'apps/x/src/keyboard.ts', 'apps/x/environment.ts']) expect(included(real, f), f).toBe(true)
  })

  it('keeps out the secret classes that the key and certificate rules of .gitignore name', () => {
    const files = [
      'apps/x/tls.crt',
      'apps/x/tls.csr',
      'apps/x/ca.srl',
      'apps/x/store.jks',
      'apps/x/store.keystore',
      'apps/x/id_rsa',
      'apps/x/id_rsa.pub',
      'apps/x/id_ed25519',
      'apps/x/admin.kubeconfig',
      'apps/x/.kube/config',
      'ops/backups/db.sql',
      'docker/pgbouncer/userlist.txt',
      'docker/keycloak/realm-export.json',
      'docker/element-call/config.json',
      'docker-compose.local-testdb.yml',
      'docker-compose.g080-throwaway.yml',
      'docker-compose.pins.yml',
      'docker-compose.state-pins.yml',
      'gremion-ui/sweep-2026-06-04/state.json',
    ]
    for (const f of files) expect(included(real, f), f).toBe(false)
  })

  it('still lets in the files of the same names that are tracked on purpose', () => {
    for (const f of ['test/host/fixtures/pooled-stack/docker-compose.pins.yml', 'docker/pgbouncer/userlist.txt.example', 'compose/ci.placeholder.env', 'docker/cloudflared/origin-ca-root.pem'])
      expect(included(real, f), f).toBe(true)
  })

  it('says in its header what it does not do: the legacy builder, and that BuildKit is the supported one', () => {
    const header = fs.readFileSync(path.join(HERE, '..', 'Dockerfile.dockerignore'), 'utf8').split('\n').filter((l) => l.startsWith('#')).join('\n')
    expect(header).toMatch(/DOCKER_BUILDKIT=0/)
    expect(header).toMatch(/root \.dockerignore/)
    expect(header).toMatch(/BuildKit is the supported builder/)
    expect(header).toMatch(/discarded builder layer/)
    expect(header).toMatch(/never in the runner stage/)
  })
})

// ---- what .gitignore marks as secret, derived from the file itself --------------------------------------------
const ROOT = path.resolve(HERE, '..', '..', '..')
const SECRET_NAME = /\.env|\.key|\.pem|\.crt|\.csr|\.srl|\.p12|\.pfx|\.jks|\.keystore|id_rsa|id_ed25519|kubeconfig|\.kube|secrets|userlist|realm-export|g080|local-testdb|pins\.yml|element-call|sweep-|backups|TEST_USERS|livekit\.prod/
const SECRET_BLOCK = /secret|credential|\bPII\b|token|private-key|never commit\b/i

/** The pattern lines (not the `!` lines) of a .gitignore that name a secret class: by their own name, or because the
 *  comment block they sit in (up to the next blank line) says they hold secrets, credentials, tokens or PII. */
function secretClassPatterns(text) {
  const out = []
  let comment = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) comment = ''
    else if (line.startsWith('#')) comment += ' ' + line
    else if (!line.startsWith('!') && (SECRET_NAME.test(line) || SECRET_BLOCK.test(comment))) out.push(line)
  }
  return out
}

/** Paths a .gitignore pattern matches, written as files below allowed folders: an unanchored pattern at any depth. */
function samplesOf(pattern) {
  const isDir = pattern.endsWith('/')
  const body = pattern.replace(/^\//, '').replace(/\/$/, '').replace(/\*+/g, 'x')
  const base = isDir ? `${body}/x` : body
  const anchored = pattern.startsWith('/') || pattern.replace(/\/$/, '').includes('/')
  return anchored ? [base] : [base, `apps/x/${base}`, `docker/${base}`]
}

describe('Dockerfile.dockerignore against .gitignore', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  const patterns = secretClassPatterns(gitignore)

  it('finds the secret classes of .gitignore in the file (the derivation itself is not empty)', () => {
    for (const p of ['.env', '*.key', '*.crt', '*.jks', 'id_rsa*', '*.kubeconfig', '.kube/', 'backups/', 'docker/pgbouncer/userlist.txt', 'docker/keycloak/realm-export.json', 'docker-compose.local-testdb.yml', 'gremion-ui/sweep-2026-06-04/'])
      expect(patterns, p).toContain(p)
    expect(patterns.length).toBeGreaterThan(25)
  })

  it('covers every line of .gitignore that names a secret class', () => {
    const open = []
    for (const p of patterns) for (const f of samplesOf(p)) if (included(real, f)) open.push(`${p}  ->  ${f}`)
    expect(open).toEqual([])
  })
})

describe('Dockerfile.dockerignore against the tracked files', () => {
  // The code map is made from the files that this context holds. The deny rules hide tracked public files too (a
  // placeholder env file, a public root certificate); an area whose only file is hidden would then be reported as
  // stale. The areas are computed by the real extract.mjs from empty files at the tracked paths, with and without
  // the rules, so the test cannot drift from the extractor.
  const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const areasOf = (paths) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-areas-'))
    try {
      const tree = path.join(dir, 'tree')
      for (const p of paths) {
        fs.mkdirSync(path.join(tree, path.dirname(p)), { recursive: true })
        fs.writeFileSync(path.join(tree, p), '')
      }
      const out = path.join(dir, 'graph.json')
      const res = spawnSync(process.execPath, [path.join(HERE, 'extract.mjs'), '--tree', '--commit', 'unknown', '--kernel', tree, '--out', out, '--deps', path.resolve(HERE, '..')], { encoding: 'utf8', maxBuffer: 1 << 28 })
      if (res.status !== 0) throw new Error(`extract.mjs exited ${res.status}: ${String(res.stderr).slice(-300)}`)
      return JSON.parse(fs.readFileSync(out, 'utf8')).nodes.filter((n) => n.kind === 'area').map((n) => n.id).sort()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('hides no area: the areas of the tracked files are the areas of the files that get in', { timeout: 180_000 }, () => {
    const all = tracked()
    expect(all.length).toBeGreaterThan(1000)
    const kept = all.filter((f) => included(real, f))
    expect(kept.length).toBeLessThan(all.length)
    const have = new Set(areasOf(kept))
    const lost = areasOf(all).filter((a) => !have.has(a))
    expect(lost).toEqual([])
  })
})
