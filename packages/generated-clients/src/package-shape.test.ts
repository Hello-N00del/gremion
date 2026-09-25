// T7: package shape mirrors @gremion/ports, plus "no `node:` import in a
// generated file" and "no `/server` entry" (the boundary-lint rule waits for
// the first server-only client, TASK-081 — brief §4 D1 adapt). RED because:
// before this commit there was no package.json to shape-check at all.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { REPO_ROOT } from './repo-root.js'

const PKG_DIR = join(REPO_ROOT, 'packages', 'generated-clients')
const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  name: string
  license: string
  type: string
  private: boolean
  repository: { type: string; url: string; directory: string }
  files: string[]
  exports: Record<string, unknown>
  publishConfig: { access: string; exports: Record<string, { types: string; import: string }> }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const portsManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'ports', 'package.json'), 'utf8')) as typeof manifest

describe('package shape mirrors @gremion/ports', () => {
  it('shares the same top-level manifest fields', () => {
    expect(manifest.license).toBe(portsManifest.license)
    expect(manifest.type).toBe(portsManifest.type)
    expect(manifest.private).toBe(portsManifest.private)
    expect(manifest.repository.type).toBe(portsManifest.repository.type)
    expect(manifest.repository.url).toBe(portsManifest.repository.url)
    expect(manifest.publishConfig.access).toBe(portsManifest.publishConfig.access)
  })

  it('files allowlist follows the same dist+src+docs pattern', () => {
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'src', '!src/**/*.test.ts', 'README.md', 'LICENSE']))
  })

  it('every dev-mode export ("import") has a matching publishConfig override with "types"', () => {
    for (const [subpath, dev] of Object.entries(manifest.exports)) {
      const devImport = (dev as { import: string }).import
      const published = manifest.publishConfig.exports[subpath]
      expect(published, `publishConfig.exports missing "${subpath}"`).toBeDefined()
      expect(published.import).toMatch(/^\.\/dist\//)
      expect(published.types).toMatch(/^\.\/dist\//)
      expect(devImport).toMatch(/^\.\/src\//)
    }
  })

  it('declares no `/server` subpath export — the boundary-lint rule waits for the first server-only client (TASK-081)', () => {
    for (const subpath of Object.keys(manifest.exports)) {
      expect(subpath).not.toMatch(/\/server(\/|$)/)
    }
    for (const subpath of Object.keys(manifest.publishConfig.exports)) {
      expect(subpath).not.toMatch(/\/server(\/|$)/)
    }
  })

  it('any @gremion/* dependency uses "workspace:*" as the only specifier', () => {
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const [name, spec] of Object.entries(deps)) {
      if (name.startsWith('@gremion/')) expect(spec).toBe('workspace:*')
    }
  })

  it('tools/ is not shipped', () => {
    for (const pattern of manifest.files) {
      expect(pattern).not.toMatch(/^tools\b/)
    }
  })
})

describe('no `node:` import in a GENERATED file', () => {
  it('every file under src/generated/ avoids node: imports and a /server entry point', () => {
    const genDir = join(PKG_DIR, 'src', 'generated')
    const files = existsSync(genDir) ? readdirSync(genDir).filter((f) => f.endsWith('.ts')) : []
    expect(files.length).toBeGreaterThan(0) // vacuity guard: this must find something to check
    for (const f of files) {
      const content = readFileSync(join(genDir, f), 'utf8')
      expect(content, `${f} imports node:`).not.toMatch(/from ['"]node:/)
      expect(content, `${f} requires node:`).not.toMatch(/require\(['"]node:/)
      expect(f, 'a generated file names a /server entry').not.toMatch(/\/server/)
    }
  })
})

describe('packed-tarball proof (D1 adapt: kept from the plan idiom)', () => {
  // Slow (runs the real build + `pnpm pack`): one test, generous timeout.
  it('pnpm pack produces a tarball whose packed manifest passes check-packed-manifest.mjs', () => {
    const outDir = mktempPackDir()
    try {
      runPnpm(['pack', '--pack-destination', outDir], PKG_DIR)
      const tgz = readdirSync(outDir).find((f) => f.endsWith('.tgz'))
      expect(tgz, `no .tgz produced in ${outDir}`).toBeDefined()
      const packedJsonPath = join(outDir, 'package.json')
      extractPackageJsonFromTarball(join(outDir, tgz as string), packedJsonPath)
      const checkerOut = execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts', 'check-packed-manifest.mjs'), packedJsonPath],
        { encoding: 'utf8' },
      )
      expect(checkerOut).toMatch(/packed manifest OK/)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }, 60_000)
})

// Windows resolves `pnpm` to a .CMD shim, which is not a real PE executable —
// `execFileSync` needs either `shell: true` (which Node then warns is unsafe
// for array args) or an explicit `cmd /c`. The latter avoids the warning
// without concatenating arguments into one shell-parsed string.
function runPnpm(args: string[], cwd: string): void {
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/d', '/s', '/c', 'pnpm', ...args], { cwd, encoding: 'utf8' })
  } else {
    execFileSync('pnpm', args, { cwd, encoding: 'utf8' })
  }
}

function mktempPackDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'generated-clients-pack-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

// Minimal untar-one-file: `tar -xzOf <tgz> package/package.json` is what
// release-npm.yml uses on Linux; Windows dev boxes may lack `tar` on PATH in
// a stripped shell, so this walks the gzip+tar streams itself rather than
// depending on an external binary being present.
function extractPackageJsonFromTarball(tgzPath: string, outPath: string): void {
  const gz = readFileSync(tgzPath)
  const tar = gunzipSync(gz)
  // POSIX tar: 512-byte header blocks; name at offset 0 (100 bytes), size at
  // offset 124 (12 bytes octal), content follows, padded to 512.
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break // end-of-archive marker
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeOctal || '0', 8)
    const contentStart = offset + 512
    if (name === 'package/package.json') {
      writeFileSync(outPath, tar.subarray(contentStart, contentStart + size))
      return
    }
    const blocks = Math.ceil(size / 512)
    offset = contentStart + blocks * 512
  }
  throw new Error(`package/package.json not found in ${tgzPath}`)
}
