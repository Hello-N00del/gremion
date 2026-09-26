// Test-only helpers (never imported by the check or the writer): a scratch
// repo tree under .gen-work/ and a fake generator, so the drift and scan logic
// is proven without Docker, Java or a Dart SDK (brief §6).
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { specStamp, STAMP_FILE, type GenerateFn } from './codegen-drift.ts'
import { SCRATCH_ROOT } from './registry.ts'

export const MINI_SPEC = {
  openapi: '3.1.0',
  info: { title: 'drift fixture', version: '1.0.0' },
  paths: {
    '/api/widgets/{id}': {
      get: { operationId: 'getWidget', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } },
    },
  },
}

export const MINI_ASYNC = { asyncapi: '3.0.0', info: { title: 'events', version: '1.0.0' }, channels: {} }

export interface FixtureEntry { name: string; type: 'openapi' | 'asyncapi'; status?: string; doc?: unknown }

export function makeFixtureRepo(entries: FixtureEntry[]): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  const root = mkdtempSync(join(SCRATCH_ROOT, 'fixture-'))
  const specs = entries.map((e) => {
    const file = `contracts/${e.name}/${e.type}.${e.name}.json`
    writeFile(root, file, JSON.stringify(e.doc ?? (e.type === 'openapi' ? MINI_SPEC : MINI_ASYNC), null, 2))
    return { name: e.name, type: e.type, file, status: e.status ?? 'active', owner: 'test' }
  })
  writeFile(root, 'contracts/registry.json', JSON.stringify({ specs }, null, 2))
  mkdirSync(join(root, 'packages', 'generated-clients-dart'), { recursive: true })
  return root
}

export function writeFile(root: string, rel: string, content: string | Buffer): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** Deterministic stand-in for the real pipeline: output depends only on the
 *  spec's bytes, like the real generator's. */
export const fakeGenerate: GenerateFn = (root, s) => {
  const h = createHash('sha256').update(readFileSync(join(root, s.specFile), 'utf8').replace(/\r\n/g, '\n')).digest('hex')
  const lib = `lib/${s.pubName}.dart`
  return new Map([
    ['.gitignore', Buffer.from('.dart_tool/\nbuild/\n')],
    ['.openapi-generator/FILES', Buffer.from(`${lib}\npubspec.yaml\n`)],
    ['pubspec.yaml', Buffer.from(`name: ${s.pubName}\n`)],
    [lib, Buffer.from(`// generated from spec sha256 ${h}\n`)],
    [STAMP_FILE, Buffer.from(specStamp(root, s))],
  ])
}

/** Write what `generate` produces into the fixture tree (the writer's job). */
export function writeGenerated(root: string, generate: GenerateFn, s: { packageDir: string } & Parameters<GenerateFn>[1]): void {
  for (const [rel, bytes] of generate(root, s)) writeFile(root, `${s.packageDir}/${rel}`, bytes)
}
