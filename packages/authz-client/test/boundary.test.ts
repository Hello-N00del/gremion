// TDD 15 (brief s.5.6): the client is server-only. No import from code a browser
// can reach: gremion-ui/src, gremion-public/src, modules/*/app/** -- server
// files (lib/server/**, *.server.ts, +server.ts, hooks.server.ts) are allowed;
// modules/*/src/** and services/** are allowed. And the package itself depends on
// no other Gremion package (HTTP only; @gremion/events is private).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PKG = fileURLToPath(new URL('../', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    if (n === 'node_modules' || n === '.svelte-kit' || n === 'dist') continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|js|mjs|svelte)$/.test(n)) out.push(p)
  }
  return out
}

const isServerFile = (rel: string) => /(^|\/)lib\/server\//.test(rel) || /\.server\.(ts|js)$/.test(rel) || /(^|\/)\+server\.(ts|js)$/.test(rel) || /(^|\/)hooks\.server\.(ts|js)$/.test(rel)

export function browserReachable(rel: string): boolean {
  if (isServerFile(rel)) return false
  if (rel.startsWith('gremion-ui/src/') || rel.startsWith('gremion-public/src/')) return true
  if (/^modules\/[^/]+\/app\//.test(rel)) return true
  return false
}

export function offenders(files: Array<{ rel: string; text: string }>): string[] {
  return files.filter((f) => browserReachable(f.rel) && /@gremion\/authz-client/.test(f.text)).map((f) => f.rel)
}

describe('authz-client boundary', () => {
  it('no browser-reachable file imports it', () => {
    const dirs = ['gremion-ui/src', 'gremion-public/src', 'modules']
    const files = dirs.flatMap((d) => walk(join(ROOT, d))).map((p) => ({ rel: relative(ROOT, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }))
    expect(files.length).toBeGreaterThan(50)
    expect(offenders(files)).toEqual([])
  })
  it('is watched failing on a seeded browser-reachable import; server files and modules/*/src stay green', () => {
    const imp = "import { createAuthzClient } from '@gremion/authz-client'"
    expect(offenders([{ rel: 'gremion-ui/src/routes/x/+page.svelte', text: imp }])).toHaveLength(1)
    expect(offenders([{ rel: 'modules/board/app/src/lib/y.ts', text: imp }])).toHaveLength(1)
    expect(offenders([{ rel: 'gremion-ui/src/lib/server/z.ts', text: imp }])).toEqual([])
    expect(offenders([{ rel: 'gremion-ui/src/routes/api/+server.ts', text: imp }])).toEqual([])
    expect(offenders([{ rel: 'modules/board/src/y.ts', text: imp }])).toEqual([])
  })
  it('depends on no other Gremion package (HTTP only)', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
    expect(deps.filter((d) => d.startsWith('@gremion/'))).toEqual([])
    for (const f of walk(join(PKG, 'src'))) expect(readFileSync(f, 'utf8')).not.toMatch(/from ['"]@gremion\//)
  })
})
