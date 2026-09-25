// Tool resolution (brief Q3/Q4, oasdiff-gate.ts shape): PATH first, else a
// digest-pinned Docker image, else FAIL CLOSED. A binary with the wrong
// version is not the tool; a docker whose daemon does not answer is not a
// runner; a `docker run` that exits 125-127 did not run the tool at all.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCRATCH_ROOT } from './registry.ts'
import { DART_IMAGE, DART_SDK_VERSION, GENERATOR_IMAGE, GENERATOR_VERSION, resolveDart, resolveGenerator } from './tools.ts'

let bin: string
beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  bin = mkdtempSync(join(SCRATCH_ROOT, 'bin-'))
})
afterEach(() => rmSync(bin, { recursive: true, force: true }))

function fakeBin(name: string, script: string): string {
  const p = join(bin, name)
  writeFileSync(p, `#!/bin/sh\n${script}\n`)
  chmodSync(p, 0o755)
  return p
}
const env = (extra: Record<string, string> = {}) => ({ PATH: bin, ...extra })
const DOCKER_OK = `case "$1" in version) echo 29.0.0; exit 0;; image) exit 0;; esac; exit 0`

describe('pins', () => {
  it('images are pinned by digest and match the recorded versions', () => {
    expect(GENERATOR_IMAGE).toMatch(new RegExp(`^openapitools/openapi-generator-cli:v${GENERATOR_VERSION}@sha256:[0-9a-f]{64}$`))
    expect(DART_IMAGE).toMatch(new RegExp(`^dart:${DART_SDK_VERSION}@sha256:[0-9a-f]{64}$`))
  })
})

describe('resolveGenerator', () => {
  it('fails closed with neither a PATH generator nor docker', () => {
    expect(() => resolveGenerator({ env: env() })).toThrow(/fail(ing)? closed/i)
  })

  it('takes a PATH generator reporting the pinned version', () => {
    fakeBin('openapi-generator-cli', `echo ${GENERATOR_VERSION}`)
    expect(resolveGenerator({ env: env() }).describe).toMatch(/PATH/)
  })

  it('ignores a PATH generator with another version, and fails closed without docker', () => {
    fakeBin('openapi-generator-cli', 'echo 7.11.0')
    expect(() => resolveGenerator({ env: env() })).toThrow(/7\.11\.0/)
  })

  it('treats a docker whose daemon does not answer as no runner', () => {
    fakeBin('docker', 'echo "Cannot connect to the Docker daemon" >&2; exit 1')
    expect(() => resolveGenerator({ env: env() })).toThrow(/fail(ing)? closed/i)
  })

  it('falls back to the pinned image when the daemon answers', () => {
    fakeBin('docker', DOCKER_OK)
    expect(resolveGenerator({ env: env() }).describe).toContain(GENERATOR_IMAGE)
  })

  it('fails closed when the pinned image was not pre-pulled', () => {
    fakeBin('docker', 'case "$1" in version) echo 29.0.0; exit 0;; image) exit 1;; esac; exit 0')
    expect(() => resolveGenerator({ env: env() })).toThrow(/images:pull/)
  })

  it('a docker run that exits 125 (daemon/engine error) is not a generator run', () => {
    fakeBin('docker', 'case "$1" in version) echo 29.0.0; exit 0;; image) exit 0;; run) echo "docker: error response from daemon" >&2; exit 125;; rm) exit 0;; esac; exit 0')
    const g = resolveGenerator({ env: env() })
    expect(() => g.run(['version'], { workDir: bin })).toThrow(/did not run/)
  })

  it('a PATH generator that exits non-zero throws with its output', () => {
    fakeBin('openapi-generator-cli', `[ "$1" = version ] && { echo ${GENERATOR_VERSION}; exit 0; }; echo "spec invalid" >&2; exit 1`)
    const g = resolveGenerator({ env: env() })
    expect(() => g.run(['generate'], { workDir: bin })).toThrow(/spec invalid/)
  })
})

describe('resolveDart', () => {
  it('fails closed with no $DART_BIN, no PATH dart and no docker', () => {
    expect(() => resolveDart({ env: env() })).toThrow(/fail(ing)? closed/i)
  })

  it('takes $DART_BIN first when it reports the pinned SDK', () => {
    const d = fakeBin('mydart', `echo "Dart SDK version: ${DART_SDK_VERSION} (stable) on \\"linux_x64\\""`)
    fakeBin('dart', 'echo "Dart SDK version: 3.0.0 (stable)"')
    expect(resolveDart({ env: env({ DART_BIN: d }) }).describe).toContain(d)
  })

  it('a $DART_BIN with another SDK version fails closed — no silent fallback past an explicit choice', () => {
    const d = fakeBin('mydart', 'echo "Dart SDK version: 3.9.0 (stable)"')
    fakeBin('docker', DOCKER_OK)
    expect(() => resolveDart({ env: env({ DART_BIN: d }) })).toThrow(/3\.9\.0/)
  })

  it('a $DART_BIN that does not exist fails closed', () => {
    expect(() => resolveDart({ env: env({ DART_BIN: join(bin, 'nope') }) })).toThrow(/DART_BIN/)
  })

  it('takes PATH dart at the pinned SDK, else the pinned image', () => {
    fakeBin('dart', `echo "Dart SDK version: ${DART_SDK_VERSION} (stable)"`)
    expect(resolveDart({ env: env() }).describe).toMatch(/PATH/)
    fakeBin('dart', 'echo "Dart SDK version: 3.10.0 (stable)"')
    fakeBin('docker', DOCKER_OK)
    expect(resolveDart({ env: env() }).describe).toContain(DART_IMAGE)
  })
})
