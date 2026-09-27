// T9: package shape mirrors @gremion/ports; check-shipped-package-files.mjs
// --static passes; the packed tarball's manifest passes check-packed-manifest.
// Dependencies are exact pins (brief §5).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PACKAGE_DIR, REPO_ROOT } from './helpers.ts'

interface Manifest {
  name: string
  license: string
  type: string
  private: boolean
  engines?: { node?: string }
  repository: { type: string; url: string; directory: string }
  files: string[]
  exports: Record<string, { import: string }>
  publishConfig: { access: string; exports: Record<string, { types: string; import: string }> }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as Manifest
const ports = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'ports', 'package.json'), 'utf8')) as Manifest

describe('T9: package shape mirrors @gremion/ports', () => {
  it('is @gremion/fastify-service-template with the same top-level fields', () => {
    expect(manifest.name).toBe('@gremion/fastify-service-template')
    expect(manifest.license).toBe(ports.license)
    expect(manifest.type).toBe(ports.type)
    expect(manifest.private).toBe(ports.private)
    expect(manifest.repository.type).toBe(ports.repository.type)
    expect(manifest.repository.url).toBe(ports.repository.url)
    expect(manifest.repository.directory).toBe('packages/fastify-service-template')
    expect(manifest.publishConfig.access).toBe(ports.publishConfig.access)
    expect(manifest.engines?.node).toBe('>=22')
  })

  it('files allowlist follows the dist+src+docs pattern and ships no tests or fixtures', () => {
    expect(manifest.files).toEqual(['dist', 'src', '!src/**/*.test.ts', 'README.md', 'LICENSE'])
  })

  it('every dev "import" export has a publishConfig twin with types, both pointing at the right trees', () => {
    expect(Object.keys(manifest.exports)).toEqual(['.'])
    for (const [subpath, dev] of Object.entries(manifest.exports)) {
      const published = manifest.publishConfig.exports[subpath]
      expect(published, `publishConfig.exports missing "${subpath}"`).toBeDefined()
      expect(dev.import).toMatch(/^\.\/src\//)
      expect(published.import).toMatch(/^\.\/dist\//)
      expect(published.types).toMatch(/^\.\/dist\//)
    }
  })

  it('pins every dependency exactly', () => {
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    expect(Object.keys(deps).length).toBeGreaterThan(0)
    for (const [name, spec] of Object.entries(deps)) {
      const pinned = name.startsWith('@gremion/') ? spec === 'workspace:*' : /^\d+\.\d+\.\d+$/.test(spec)
      expect(pinned, `${name}@${spec}`).toBe(true)
    }
  })

  it('check-shipped-package-files.mjs --static passes and covers this package', () => {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-shipped-package-files.mjs'), '--static'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(out).toMatch(/@gremion\/fastify-service-template: 1 declared path\(s\) — src\/index\.ts/)
    expect(out).toMatch(/OK — every declared entry point survives packing/)
  })
})

describe('T9: packed-tarball proof', () => {
  // Slow (real build + pnpm pack), one test. Packs into the gitignored .tmp/.
  it('pnpm pack produces a tarball whose manifest passes check-packed-manifest.mjs and ships dist/', () => {
    const outDir = join(PACKAGE_DIR, '.tmp', 'pack')
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    try {
      runPnpm(['pack', '--pack-destination', outDir], PACKAGE_DIR)
      const tgz = readdirSync(outDir).find((f) => f.endsWith('.tgz'))
      expect(tgz, `no .tgz produced in ${outDir}`).toBeDefined()
      const entries = untar(join(outDir, tgz as string))
      expect(entries.has('package/dist/index.js')).toBe(true)
      expect(entries.has('package/dist/index.d.ts')).toBe(true)
      expect([...entries.keys()].filter((n) => n.includes('/test/') || n.includes('.tmp/'))).toEqual([])
      const packedJsonPath = join(outDir, 'package.json')
      writeFileSync(packedJsonPath, entries.get('package/package.json') as Buffer)
      const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-packed-manifest.mjs'), packedJsonPath], {
        encoding: 'utf8',
      })
      expect(out).toMatch(/packed manifest OK/)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 120_000)
})

function runPnpm(args: string[], cwd: string): void {
  if (process.platform === 'win32') execFileSync('cmd', ['/d', '/s', '/c', 'pnpm', ...args], { cwd, encoding: 'utf8' })
  else execFileSync('pnpm', args, { cwd, encoding: 'utf8' })
}

/** Minimal gzip+tar reader (POSIX headers): name -> content. */
function untar(tgzPath: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(tgzPath))
  const out = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
    const start = offset + 512
    out.set(name, tar.subarray(start, start + size))
    offset = start + Math.ceil(size / 512) * 512
  }
  return out
}
