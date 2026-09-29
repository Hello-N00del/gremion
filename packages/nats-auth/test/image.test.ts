// Reachable where it runs (G5, Q11, Q12): tenant-create runs
// `pnpm exec nats-auth init` in the builder stage of gremion-ui/Dockerfile
// with working_dir /repo/gremion-ui. pnpm links a workspace dependency's bin
// into gremion-ui/node_modules/.bin only when the bin FILE exists at
// `pnpm install` time; a bin copied after the install is never linked and
// `pnpm exec nats-auth` exits 254 "Command not found" (house review HIGH,
// round 1: every call site -- make nats-init, gremion-deploy step 4,
// pooled-stack-proof phase_state_up -- died on it). This reads the Dockerfile
// as the build runs it; `scripts/image-check.sh` proves the same on the image.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.env.NATS_AUTH_WIRING_ROOT ?? path.resolve(import.meta.dirname, '../../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

/** The builder stage's instructions, continuation lines joined. */
export function builderStage(dockerfile: string): string[] {
  const lines = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+builder$/i.test(l))
  if (start < 0) throw new Error('Dockerfile: no builder stage')
  const end = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l))
  return lines.slice(start, end < 0 ? undefined : end)
}

/** Repo paths the builder has copied before its first `pnpm install`. */
export function copiedBeforeInstall(stage: string[]): string[] {
  const install = stage.findIndex((l) => /^RUN\s+.*\bpnpm install\b/.test(l))
  if (install < 0) throw new Error('builder stage: no pnpm install')
  const out: string[] = []
  for (const l of stage.slice(0, install)) {
    const m = /^COPY\s+(?!--from)(.+)$/i.exec(l)
    if (!m) continue
    const parts = m[1]!.split(/\s+/).filter((p) => !p.startsWith('--'))
    out.push(...parts.slice(0, -1).map((p) => p.replace(/^\.\//, '').replace(/\/$/, '')))
  }
  return out
}

/** Bins of `pkgDir` the install cannot link, because no COPY before it covers the file. */
export function unlinkedBins(dockerfile: string, pkgDir: string, bins: Record<string, string>): string[] {
  const copied = copiedBeforeInstall(builderStage(dockerfile))
  return Object.entries(bins)
    .map(([name, rel]) => ({ name, file: path.posix.join(pkgDir, rel) }))
    .filter(({ file }) => !copied.some((c) => c === '.' || file === c || file.startsWith(`${c}/`)))
    .map(({ name, file }) => `${name} (${file})`)
}

describe('the migrate image links the nats-auth bin (G5, Q12)', () => {
  const pkg = JSON.parse(read('packages/nats-auth/package.json')) as { bin: Record<string, string> }

  test('the package declares the bin every call site execs', () => {
    expect(pkg.bin['nats-auth']).toBe('./bin/nats-auth.mjs')
  })

  test('gremion-ui depends on @gremion/nats-auth as a devDependency (linked in the builder, left out of the runner)', () => {
    const ui = JSON.parse(read('gremion-ui/package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    expect(ui.devDependencies?.['@gremion/nats-auth']).toBe('workspace:*')
    expect(ui.dependencies?.['@gremion/nats-auth']).toBeUndefined()
  })

  test('the builder copies the bin file BEFORE pnpm install, so pnpm links node_modules/.bin/nats-auth', () => {
    expect(unlinkedBins(read('gremion-ui/Dockerfile'), 'packages/nats-auth', pkg.bin)).toEqual([])
  })

  test('break: only the manifest before the install (round-1 Dockerfile) leaves the bin unlinked', () => {
    const broken = [
      'FROM node:26-alpine AS builder',
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./',
      'COPY packages/nats-auth/package.json ./packages/nats-auth/',
      'RUN pnpm install --frozen-lockfile',
      'COPY packages/nats-auth ./packages/nats-auth/',
      'FROM node:26-alpine AS runner',
    ].join('\n')
    expect(unlinkedBins(broken, 'packages/nats-auth', pkg.bin)).toEqual(['nats-auth (packages/nats-auth/bin/nats-auth.mjs)'])
  })

  test('a COPY of the bin in the runner stage does not count', () => {
    const runnerOnly = [
      'FROM node:26-alpine AS builder',
      'RUN pnpm install --frozen-lockfile',
      'FROM node:26-alpine AS runner',
      'COPY packages/nats-auth/bin ./packages/nats-auth/bin/',
    ].join('\n')
    expect(unlinkedBins(runnerOnly, 'packages/nats-auth', pkg.bin)).toHaveLength(1)
  })
})
