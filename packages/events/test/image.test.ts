// Reach (G7, acceptance "Reach"): @gremion/events resolves in the migrate / tenant-create image (the
// builder stage of gremion-ui/Dockerfile) and NOT in the long-running gremion-ui runner. The runbook
// runs `pnpm tenant-create exec events dlq-replay`; pnpm links a workspace bin into
// gremion-ui/node_modules/.bin only when the bin FILE exists at `pnpm install` time (the nats-auth
// image.test.ts lesson). This reads the Dockerfile as the build runs it; scripts/image-check.sh proves
// the same on the built image.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

function builderStage(dockerfile: string): string[] {
  const lines = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+builder$/i.test(l))
  if (start < 0) throw new Error('Dockerfile: no builder stage')
  const end = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l))
  return lines.slice(start, end < 0 ? undefined : end)
}

/** Repo paths the stage copied from the build context, split at the first `pnpm install`. */
function copies(stage: string[]): { beforeInstall: string[]; all: string[] } {
  const install = stage.findIndex((l) => /^RUN\s+.*\bpnpm install\b/.test(l))
  if (install < 0) throw new Error('builder stage: no pnpm install')
  const take = (ls: string[]): string[] =>
    ls.flatMap((l) => {
      const m = /^COPY\s+(.+)$/i.exec(l)
      if (!m) return []
      const words = m[1]!.split(/\s+/)
      if (words.some((w) => /^--from(=|$)/i.test(w))) return []
      return words.filter((p) => !p.startsWith('--')).slice(0, -1).map((p) => p.replace(/^\.\//, '').replace(/\/$/, ''))
    })
  return { beforeInstall: take(stage.slice(0, install)), all: take(stage) }
}

const covers = (copied: string[], file: string): boolean => copied.some((c) => c === '.' || file === c || file.startsWith(`${c}/`))

describe('@gremion/events is reachable in the migrate image and not in the runner (G7)', () => {
  const pkg = JSON.parse(read('packages/events/package.json')) as { bin: Record<string, string> }
  const dockerfile = read('gremion-ui/Dockerfile')

  test('the package declares the bin the runbook execs', () => {
    expect(pkg.bin.events).toBe('./bin/events.mjs')
  })

  test('gremion-ui lists it as a devDependency only, so deploy --prod leaves it out of the runner', () => {
    const ui = JSON.parse(read('gremion-ui/package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    expect(ui.devDependencies?.['@gremion/events']).toBe('workspace:*')
    expect(ui.dependencies?.['@gremion/events']).toBeUndefined()
  })

  test('the builder copies the manifest and the bin BEFORE pnpm install, and the sources after', () => {
    const { beforeInstall, all } = copies(builderStage(dockerfile))
    expect(covers(beforeInstall, 'packages/events/package.json')).toBe(true)
    expect(covers(beforeInstall, 'packages/events/bin/events.mjs')).toBe(true)
    expect(covers(all, 'packages/events/sql/plumbing.sql')).toBe(true)
    expect(covers(all, 'packages/events/src/index.ts')).toBe(true)
  })

  test('break: the manifest-only Dockerfile leaves the bin unlinked', () => {
    const broken = [
      'FROM node:26-alpine AS builder',
      'COPY packages/events/package.json ./packages/events/',
      'RUN pnpm install --frozen-lockfile',
      'COPY packages/events ./packages/events/',
      'FROM node:26-alpine AS runner',
    ].join('\n')
    expect(covers(copies(builderStage(broken)).beforeInstall, 'packages/events/bin/events.mjs')).toBe(false)
  })

  test('the runner stage copies nothing of the package from the build context', () => {
    const lines = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    const runnerAt = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+runner$/i.test(l))
    expect(runnerAt).toBeGreaterThan(0)
    expect(lines.slice(runnerAt).filter((l) => /^COPY\b/i.test(l) && l.includes('packages/events') && !/--from=/i.test(l))).toEqual([])
  })
})
