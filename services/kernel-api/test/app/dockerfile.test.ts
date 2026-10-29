// TASK-080-a round 3: the image must be BUILDABLE. 080-a made the service depend on @gremion/events, @gremion/nats-auth and
// @gremion/ports (the relay, the seed store); the Dockerfile copied only the 077 packages, so `pnpm build` died in the
// image with "Could not resolve @gremion/events" while every unit and integration test (which run from the checkout) stayed
// green. The check: every workspace package the service reaches, directly or through another, is copied twice (manifest
// first for the cache, then the source) in the builder stage.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SERVICE = fileURLToPath(new URL('../../', import.meta.url))
const REPO = join(SERVICE, '..', '..')

type Pkg = { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
const readPkg = (dir: string): Pkg => JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8')) as Pkg

/** Directory (relative to the repo) of a workspace package by name: packages/<x> for every @gremion/<x> that has one. */
const dirOf = (name: string): string => `packages/${name.replace('@gremion/', '')}`

/**
 * The workspace packages reachable from `entry` through dependencies AND devDependencies, at every level:
 * `pnpm deploy --legacy` resolves a workspace package's dev dependencies too (tenant-store's devDependency on
 * @gremion/retention made it die with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND although nothing imports it at runtime).
 */
export function workspaceClosure(read: (dir: string) => Pkg, entry: string): string[] {
  const seen = new Set<string>()
  const walk = (dir: string, withDev: boolean): void => {
    const p = read(dir)
    const deps = { ...p.dependencies, ...(withDev ? p.devDependencies : {}) }
    for (const [n, v] of Object.entries(deps)) {
      if (!n.startsWith('@gremion/') || !String(v).startsWith('workspace:')) continue
      const d = dirOf(n)
      if (seen.has(d)) continue
      seen.add(d)
      walk(d, true)
    }
  }
  walk(entry, true)
  return [...seen].sort()
}

export function missingCopies(dockerfile: string, packages: readonly string[]): string[] {
  const builder = dockerfile.slice(0, dockerfile.indexOf('AS runner'))
  const out: string[] = []
  for (const d of packages) {
    if (!new RegExp(`^COPY ${d}/package\\.json ./${d}/\\s*$`, 'm').test(builder)) out.push(`${d}: manifest not copied`)
    if (!new RegExp(`^COPY ${d} ./${d}/\\s*$`, 'm').test(builder)) out.push(`${d}: source not copied`)
  }
  return out
}

describe('services/kernel-api/Dockerfile copies every workspace package the service reaches', () => {
  const dockerfile = readFileSync(join(SERVICE, 'Dockerfile'), 'utf8')

  it('the closure includes the 080-a packages (events, nats-auth, ports), and the builder stage copies all of it', () => {
    const closure = workspaceClosure(readPkg, 'services/kernel-api')
    expect(closure).toEqual(expect.arrayContaining(['packages/db', 'packages/events', 'packages/nats-auth', 'packages/ports', 'packages/tenant-store']))
    expect(missingCopies(dockerfile, closure)).toEqual([])
  })

  it('the check sees a missing package (guard): a Dockerfile without the events copies is RED', () => {
    const without = dockerfile.replace(/^COPY packages\/events[^\n]*\n/gm, '')
    expect(missingCopies(without, ['packages/events'])).toEqual(['packages/events: manifest not copied', 'packages/events: source not copied'])
  })
})
