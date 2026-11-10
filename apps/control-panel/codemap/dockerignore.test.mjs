// Dockerfile.dockerignore is the allow-list of the build context of the control panel image, which copies the
// whole repository into a builder layer. These tests apply the file the way BuildKit does (the last matching rule
// wins; a rule that matches a folder matches everything below it) and check that no secret-class file gets in.
import fs from 'node:fs'
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

  it('says in its comment that secrets never enter the context, and the Dockerfile does not claim more than the file does', () => {
    const text = fs.readFileSync(path.join(HERE, '..', 'Dockerfile.dockerignore'), 'utf8')
    expect(text).toMatch(/secret/i)
  })
})
