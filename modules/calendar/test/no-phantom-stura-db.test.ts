/**
 * Phantom @gremion/db dependency guard (calendar leaf analog of
 * services/newsletter/test/no-phantom-stura-db.test.ts, WP6-1 / #203).
 *
 * The calendar leaf declares two workspace packages: `@gremion/ports` (the real shared kernel-leaf
 * contract, imported across src/ and test/) and `@gremion/tenant-store` (the one way into a tenant database:
 * the leaf opens the customer's lifecycle database through it). It declares NOT `@gremion/db`: the kernel
 * database package arrives transitively through the tenant store and is never a direct coupling. This guard
 * fails if that phantom workspace edge ever creeps in, and pins that the genuine couplings stay declared.
 *
 * The Dockerfile may name the kernel database package only in the two COPY lines that bring the tenant
 * store's TRANSITIVE workspace dependency into the build tree (`pnpm install --frozen-lockfile` fails
 * without it), the way the board leaf's does.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_ROOT = path.resolve(__dirname, '..')

const pkg = JSON.parse(
  fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf-8'),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

const dockerfile = fs.readFileSync(path.join(SERVICE_ROOT, 'Dockerfile'), 'utf-8')

/** The only Dockerfile lines allowed to name the kernel DB package: the transitive COPY lines. */
const DB_COPY_LINE = /^COPY packages\/db(\/package\.json)? \.\/packages\/db\/$/

/** Dockerfile lines that name @gremion/db or packages/db other than the transitive COPY lines. */
function directDbCouplings(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => (l.includes('@gremion/db') || /packages\/db(\/|\s|$)/.test(l)) && !DB_COPY_LINE.test(l))
}

describe('no phantom @gremion/db in the calendar leaf', () => {
  it('package.json declares no @gremion/db dependency', () => {
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(Object.keys(allDeps)).not.toContain('@gremion/db')
  })

  it('the Dockerfile names the kernel DB package only in its two transitive COPY lines', () => {
    expect(directDbCouplings(dockerfile)).toEqual([])
    expect(dockerfile.split(/\r?\n/).filter((l) => DB_COPY_LINE.test(l.trim()))).toHaveLength(2)
  })

  it('the guard sees a direct coupling (a comment, a --filter, a RUN step) when there is one', () => {
    expect(directDbCouplings('RUN pnpm --filter @gremion/db build')).toHaveLength(1)
    expect(directDbCouplings('# the @gremion/db package')).toHaveLength(1)
    expect(directDbCouplings('COPY packages/db ./packages/db/')).toEqual([])
  })

  it('the genuine @gremion/ports coupling stays declared in package.json', () => {
    expect(pkg.dependencies?.['@gremion/ports']).toBe('workspace:*')
  })

  it('the tenant store, the one way into a tenant database, is declared and its workspace dependencies are copied by the Dockerfile', () => {
    expect(pkg.dependencies?.['@gremion/tenant-store']).toBe('workspace:*')
    for (const dir of ['packages/ports', 'packages/db', 'packages/generated-clients', 'packages/module-catalogue', 'packages/tenant-store', 'packages/storage', 'packages/retention']) {
      expect(dockerfile, `${dir}/package.json is not copied before pnpm install`).toContain(`COPY ${dir}/package.json ./${dir}/`)
      expect(dockerfile, `${dir} is not copied before the build`).toContain(`COPY ${dir} ./${dir}/`)
    }
  })
})
