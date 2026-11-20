// CD stage 1, unit U6g: the tenant-create one-shot (the `builder` target of gremion-ui/Dockerfile) carries no
// root scripts/ directory, and dump/cli.ts imports scripts/migrations/pre-apply.mjs at load; dump/index.ts
// re-exports cli.ts. So anything tenant-create imports must never reach cli.ts, or EVERY verb of the one-shot
// dies at load with a module-not-found that no checkout test would see. The enable catch-up reaches the dump code
// through @gremion/tenant-store/lifecycle (lifecycle/index.ts -> dump/catchup.ts), and this walks that import
// graph statically.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../../', import.meta.url))
const REPO = resolve(PKG, '..', '..')
const rel = (p: string) => relative(REPO, p).replace(/\\/g, '/')

const IMPORT = /(?:^|[\s;])(?:import|export)\b[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every module specifier a file names (static import, export-from, side-effect import, dynamic import with a literal). */
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const m of text.matchAll(IMPORT)) out.push((m[1] ?? m[2] ?? m[3])!)
  return out
}

/** The files reachable from `entry` through RELATIVE specifiers, plus every relative specifier that leaves the package src. */
function reach(entry: string): { files: Set<string>; escapes: string[] } {
  const files = new Set<string>()
  const escapes: string[] = []
  const todo = [entry]
  while (todo.length) {
    const file = todo.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const spec of specifiers(file)) {
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(file), spec)
      if (!rel(target).startsWith('packages/tenant-store/src/')) {
        escapes.push(`${rel(file)} -> ${spec}`)
        continue
      }
      const ts = target.replace(/\.js$/, '.ts')
      if (existsSync(ts)) todo.push(ts)
      else if (existsSync(join(target, 'index.ts'))) todo.push(join(target, 'index.ts'))
    }
  }
  return { files, escapes }
}

function sourceFiles(dir: string, accept: (p: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, accept, out)
    else if (accept(p)) out.push(p)
  }
  return out
}

describe('the enable catch-up never makes tenant-create load cli.ts', () => {
  it('the walk sees the catch-up factory and the dump code it needs (the guard is not vacuous)', () => {
    const { files } = reach(join(PKG, 'src', 'lifecycle', 'index.ts'))
    const names = [...files].map(rel)
    expect(names).toContain('packages/tenant-store/src/dump/catchup.ts')
    expect(names).toContain('packages/tenant-store/src/dump/retire.ts')
    expect(names).toContain('packages/tenant-store/src/dump/take.ts')
    expect(names.length).toBeGreaterThan(20)
  })

  it('lifecycle/index.ts reaches neither dump/cli.ts nor dump/index.ts, and no relative import leaves the package src', () => {
    const { files, escapes } = reach(join(PKG, 'src', 'lifecycle', 'index.ts'))
    const names = [...files].map(rel)
    expect(names).not.toContain('packages/tenant-store/src/dump/cli.ts')
    expect(names).not.toContain('packages/tenant-store/src/dump/index.ts')
    expect(escapes).toEqual([])
    for (const f of files) for (const spec of specifiers(f)) expect(spec, `${rel(f)} imports ${spec}`).not.toMatch(/scripts\/|pre-apply/)
  })

  it('dump/catchup.ts, retire.ts and hook.ts import only what the one-shot image carries', () => {
    for (const name of ['catchup.ts', 'retire.ts', 'hook.ts', 'take.ts', 'ledger.ts']) {
      const file = join(PKG, 'src', 'dump', name)
      for (const spec of specifiers(file)) expect(spec, `${name} imports ${spec}`).not.toMatch(/cli(\.js)?$|scripts\/|pre-apply/)
    }
  })

  it('no source of the tenant-create image imports @gremion/tenant-store/dump (only the kernel API image bundles it)', () => {
    const roots = [join(REPO, 'packages', 'provisioning', 'src'), join(REPO, 'gremion-ui', 'scripts'), join(REPO, 'gremion-ui', 'src', 'lib', 'server', 'tenant')]
    const offenders: string[] = []
    let seen = 0
    for (const root of roots) {
      for (const f of sourceFiles(root, (p) => /\.(ts|mjs|js)$/.test(p) && !/\.test\./.test(p))) {
        seen += 1
        if (statSync(f).size > 0 && /@gremion\/tenant-store\/dump/.test(readFileSync(f, 'utf8'))) offenders.push(rel(f))
      }
    }
    expect(seen).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})
