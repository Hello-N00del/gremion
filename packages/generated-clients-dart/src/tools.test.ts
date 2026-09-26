// Tool resolution (brief Q3/Q4, oasdiff-gate.ts shape): PATH first, else a
// digest-pinned Docker image, else FAIL CLOSED. A binary with the wrong
// version is not the tool; a docker whose daemon does not answer is not a
// runner; a `docker run` that exits 125-127 did not run the tool at all.
//
// The fake tools are Node scripts run through an injected spawn, so these
// rules are exercised on Windows as well as Linux. A `#!/bin/sh` fake cannot
// be spawned on win32, which left this suite red there. The injected spawn
// still starts real child processes: exit codes, stdout/stderr, ENOENT for an
// absent tool and the timeout kill all come from the OS, not from a stub.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { SCRATCH_ROOT } from './registry.ts'
import { DART_IMAGE, DART_SDK_VERSION, GENERATOR_IMAGE, GENERATOR_VERSION, resolveDart, resolveGenerator, type SpawnFn } from './tools.ts'

let bin: string
beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  bin = mkdtempSync(join(SCRATCH_ROOT, 'bin-'))
})
afterEach(() => rmSync(bin, { recursive: true, force: true }))

/** What a fake tool does for a given first argument ('*' = any other). */
interface Reply { out?: string; err?: string; code?: number; hang?: boolean }

/** Writes a fake tool: a plain Node script (no imports, so it runs as CJS or
 *  ESM) that answers by its first argument. Returns its absolute path. */
function fakeBin(name: string, replies: Record<string, Reply>): string {
  const p = join(bin, name)
  writeFileSync(p, [
    `const replies = ${JSON.stringify(replies)}`,
    `const r = replies[process.argv[2] ?? ''] ?? replies['*'] ?? {}`,
    'if (r.hang) { for (;;) {} }',
    `if (r.out) process.stdout.write(r.out + '\\n')`,
    `if (r.err) process.stderr.write(r.err + '\\n')`,
    'process.exitCode = r.code ?? 0',
    '',
  ].join('\n'))
  return p
}

/** Resolves a bare command against the single PATH entry the resolver passed
 *  (an absolute one as given) and runs the fake under this Node. A tool with
 *  no fake is spawned for real, so its ENOENT comes from the OS as in
 *  production. */
const spawn: SpawnFn = (cmd, args, options) => {
  const p = isAbsolute(cmd) ? cmd : join(options.env?.PATH ?? '', cmd)
  if (!existsSync(p)) return spawnSync(p, args, options)
  return spawnSync(process.execPath, [p, ...args], options)
}
const env = (extra: Record<string, string> = {}) => ({ PATH: bin, ...extra })
const DOCKER_OK: Record<string, Reply> = { version: { out: '29.0.0' }, '*': {} }

describe('pins', () => {
  it('images are pinned by digest and match the recorded versions', () => {
    expect(GENERATOR_IMAGE).toMatch(new RegExp(`^openapitools/openapi-generator-cli:v${GENERATOR_VERSION}@sha256:[0-9a-f]{64}$`))
    expect(DART_IMAGE).toMatch(new RegExp(`^dart:${DART_SDK_VERSION}@sha256:[0-9a-f]{64}$`))
  })
})

describe('production spawn (no injection)', () => {
  it('fails closed on an empty PATH with the real spawnSync', () => {
    expect(() => resolveGenerator({ env: env() })).toThrow(/fail(ing)? closed/i)
    expect(() => resolveDart({ env: env() })).toThrow(/fail(ing)? closed/i)
  })
})

describe('resolveGenerator', () => {
  it('fails closed with neither a PATH generator nor docker', () => {
    expect(() => resolveGenerator({ env: env(), spawn })).toThrow(/fail(ing)? closed/i)
  })

  it('takes a PATH generator reporting the pinned version', () => {
    fakeBin('openapi-generator-cli', { '*': { out: GENERATOR_VERSION } })
    expect(resolveGenerator({ env: env(), spawn }).describe).toMatch(/PATH/)
  })

  it('ignores a PATH generator with another version, and fails closed without docker', () => {
    fakeBin('openapi-generator-cli', { '*': { out: '7.11.0' } })
    expect(() => resolveGenerator({ env: env(), spawn })).toThrow(/7\.11\.0/)
  })

  it('treats a docker whose daemon does not answer as no runner', () => {
    fakeBin('docker', { '*': { err: 'Cannot connect to the Docker daemon', code: 1 } })
    expect(() => resolveGenerator({ env: env(), spawn })).toThrow(/fail(ing)? closed/i)
  })

  it('falls back to the pinned image when the daemon answers', () => {
    fakeBin('docker', DOCKER_OK)
    expect(resolveGenerator({ env: env(), spawn }).describe).toContain(GENERATOR_IMAGE)
  })

  it('fails closed when the pinned image was not pre-pulled', () => {
    fakeBin('docker', { version: { out: '29.0.0' }, image: { code: 1 }, '*': {} })
    expect(() => resolveGenerator({ env: env(), spawn })).toThrow(/images:pull/)
  })

  it('a docker run that exits 125 (daemon/engine error) is not a generator run', () => {
    fakeBin('docker', { version: { out: '29.0.0' }, run: { err: 'docker: error response from daemon', code: 125 }, '*': {} })
    const g = resolveGenerator({ env: env(), spawn })
    expect(() => g.run(['version'], { workDir: bin })).toThrow(/did not run/)
  })

  it('a PATH generator that exits non-zero throws with its output', () => {
    fakeBin('openapi-generator-cli', { version: { out: GENERATOR_VERSION }, '*': { err: 'spec invalid', code: 1 } })
    const g = resolveGenerator({ env: env(), spawn })
    expect(() => g.run(['generate'], { workDir: bin })).toThrow(/spec invalid/)
  })
})

describe('resolveDart', () => {
  it('fails closed with no $DART_BIN, no PATH dart and no docker', () => {
    expect(() => resolveDart({ env: env(), spawn })).toThrow(/fail(ing)? closed/i)
  })

  it('takes $DART_BIN first when it reports the pinned SDK', () => {
    const d = fakeBin('mydart', { '*': { out: `Dart SDK version: ${DART_SDK_VERSION} (stable) on "linux_x64"` } })
    fakeBin('dart', { '*': { out: 'Dart SDK version: 3.0.0 (stable)' } })
    expect(resolveDart({ env: env({ DART_BIN: d }), spawn }).describe).toContain(d)
  })

  it('a $DART_BIN with another SDK version fails closed — no silent fallback past an explicit choice', () => {
    const d = fakeBin('mydart', { '*': { out: 'Dart SDK version: 3.9.0 (stable)' } })
    fakeBin('docker', DOCKER_OK)
    expect(() => resolveDart({ env: env({ DART_BIN: d }), spawn })).toThrow(/3\.9\.0/)
  })

  it('a $DART_BIN that does not exist fails closed', () => {
    expect(() => resolveDart({ env: env({ DART_BIN: join(bin, 'nope') }), spawn })).toThrow(/DART_BIN/)
  })

  it('takes PATH dart at the pinned SDK, else the pinned image', () => {
    fakeBin('dart', { '*': { out: `Dart SDK version: ${DART_SDK_VERSION} (stable)` } })
    expect(resolveDart({ env: env(), spawn }).describe).toMatch(/PATH/)
    fakeBin('dart', { '*': { out: 'Dart SDK version: 3.10.0 (stable)' } })
    fakeBin('docker', DOCKER_OK)
    expect(resolveDart({ env: env(), spawn }).describe).toContain(DART_IMAGE)
  })
})

describe('run hygiene', () => {
  it('a PATH generator whose version probe fails is named as such, not as absent', () => {
    fakeBin('openapi-generator-cli', { '*': { err: 'java: not found', code: 127 } })
    expect(() => resolveGenerator({ env: env(), spawn })).toThrow(/openapi-generator-cli.*version.*exited 127/)
  })

  it('a hung tool is killed at the timeout and reported as not having run', () => {
    fakeBin('openapi-generator-cli', { version: { out: GENERATOR_VERSION }, '*': { hang: true } })
    const g = resolveGenerator({ env: env(), spawn, timeoutMs: 300 })
    expect(() => g.run(['generate'], { workDir: bin })).toThrow(/timed out|did not (run|finish)/)
  })
})
