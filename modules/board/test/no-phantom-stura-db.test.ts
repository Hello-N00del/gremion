// modules/board/test/no-phantom-stura-db.test.ts
//
// The board leaf reaches its per-(tenant, module) databases ONLY through
// @gremion/tenant-store (openTenantDb + schemaGate, R29-BOARD-STORE-K). That is
// the one workspace package it may depend on. It must NOT depend on `@gremion/db`
// directly (the kernel database package arrives transitively, through the
// tenant store, and is never a direct coupling) nor on any other `@gremion/*`
// workspace package. This guard fails if a kernel-DB coupling ever creeps back
// into package.json or the Dockerfile, AND if any source file hardcodes a
// `stura_`-prefixed database name (which would let the leaf phantom-connect to
// the LIVE staging kernel DB — the exact smoke-incident the carve hit and this
// test's name warns against).
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_ROOT = path.resolve(__dirname, '..')

const pkg = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const dockerfile = fs.readFileSync(path.join(SERVICE_ROOT, 'Dockerfile'), 'utf-8')
// Read through the leaf's own workspace link (node_modules/@gremion/tenant-store), the way the
// leaf itself resolves it, not by a path literal that climbs out of modules/board/ (which
// check-module-source-scan forbids).
const tenantStorePkg = JSON.parse(
  fs.readFileSync(path.join(SERVICE_ROOT, 'node_modules', '@gremion', 'tenant-store', 'package.json'), 'utf-8'),
) as { dependencies?: Record<string, string> }

/**
 * The only Dockerfile lines allowed to name the kernel DB package: the two COPY lines that
 * bring the tenant store's TRANSITIVE workspace dependency into the build tree (`pnpm install
 * --frozen-lockfile` fails without it). Anything else naming it (a comment, a --filter, a
 * RUN build step, a second COPY form) is a direct coupling.
 */
export const DB_COPY_LINE = /^COPY packages\/db(\/package\.json)? \.\/packages\/db\/$/

/** Dockerfile lines that name @gremion/db or packages/db other than the transitive COPY lines. */
export function directDbCouplings(dockerfileText: string): string[] {
  return dockerfileText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => (l.includes('@gremion/db') || /packages\/db(\/|\s|$)/.test(l)) && !DB_COPY_LINE.test(l))
}

/** The only workspace package the leaf may depend on (TRD-426: the one way into a tenant database). */
export const ALLOWED_WORKSPACE_DEPS: readonly string[] = ['@gremion/tenant-store']

/** The @gremion/* names in a dependency map that are not allowed. */
export function forbiddenWorkspaceDeps(deps: Record<string, string>): string[] {
  return Object.keys(deps)
    .filter((k) => k.startsWith('@gremion/') && !ALLOWED_WORKSPACE_DEPS.includes(k))
    .sort()
}

function* walkSrc(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e)
    if (fs.statSync(p).isDirectory()) yield* walkSrc(p)
    else if (p.endsWith('.ts')) yield p
  }
}

const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }

describe('forbiddenWorkspaceDeps (self-test)', () => {
  it('allows exactly @gremion/tenant-store', () => {
    expect(forbiddenWorkspaceDeps({ '@gremion/tenant-store': 'workspace:*', postgres: '^3', zod: '^4' })).toEqual([])
  })
  it('refuses a direct @gremion/db and every other @gremion/* package', () => {
    expect(
      forbiddenWorkspaceDeps({
        '@gremion/tenant-store': 'workspace:*',
        '@gremion/db': 'workspace:*',
        '@gremion/module-catalogue': 'workspace:*',
        '@gremion/tenant-store-extra': 'workspace:*',
      }),
    ).toEqual(['@gremion/db', '@gremion/module-catalogue', '@gremion/tenant-store-extra'])
  })
})

describe('directDbCouplings (self-test)', () => {
  it('accepts exactly the two transitive COPY lines', () => {
    expect(directDbCouplings('COPY packages/db/package.json ./packages/db/\nCOPY packages/db ./packages/db/\n')).toEqual([])
  })
  it('refuses a comment, a --filter, a build step and differently shaped COPYs', () => {
    expect(
      directDbCouplings(
        [
          '# the leaf bundles @gremion/db',
          'RUN pnpm --filter @gremion/db build',
          'RUN cd packages/db && pnpm build',
          'COPY packages/db ./somewhere-else/',
          'COPY --from=builder /repo/packages/db ./packages/db/',
        ].join('\n'),
      ),
    ).toHaveLength(5)
  })
})

describe('board leaf — no phantom kernel-DB coupling', () => {
  it('package.json declares no direct @gremion/db dependency', () => {
    expect(Object.keys(allDeps)).not.toContain('@gremion/db')
  })

  it('package.json declares no @gremion/* workspace coupling except @gremion/tenant-store', () => {
    expect(forbiddenWorkspaceDeps(allDeps)).toEqual([])
  })

  it('package.json declares @gremion/tenant-store as a runtime dependency (the seam the store uses)', () => {
    expect(pkg.dependencies?.['@gremion/tenant-store']).toBe('workspace:*')
  })

  it("Dockerfile names @gremion/db / packages/db only on the COPY lines for the tenant store's transitive dependency", () => {
    expect(directDbCouplings(dockerfile)).toEqual([])
  })

  it('Dockerfile copies packages/db exactly when @gremion/tenant-store depends on @gremion/db', () => {
    const copies = dockerfile.split(/\r?\n/).some((l) => /^COPY packages\/db /.test(l.trim()))
    expect(copies).toBe(Boolean(tenantStorePkg.dependencies?.['@gremion/db']))
  })

  it('no source file hardcodes a `stura_`-prefixed (live kernel) database name', () => {
    const offenders: string[] = []
    for (const abs of walkSrc(path.join(SERVICE_ROOT, 'src'))) {
      if (/stura_/.test(fs.readFileSync(abs, 'utf-8'))) {
        offenders.push(path.relative(SERVICE_ROOT, abs))
      }
    }
    expect(offenders, `files hardcoding a stura_ DB name: ${offenders.join(', ')}`).toEqual([])
  })
})
