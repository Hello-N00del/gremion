// Shape of every COMMITTED Dart surface package (the importable proof Dart
// supports without a publish): pubspec name/version follow the registry and
// the spec, the entry library exists, the lock is committed and pins every
// direct dependency, LF is enforced package-locally, and the committed
// analysis_options.yaml passes the analyze-gate policy.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { checkAnalysisOptions } from './analyze-gate.ts'
import { loadDartSurfaces } from './registry.ts'
import { REPO_ROOT } from './repo-root.ts'

const { surfaces } = loadDartSurfaces(REPO_ROOT)

describe('committed Dart surface packages', () => {
  it('there is at least one', () => expect(surfaces.length).toBeGreaterThanOrEqual(1))

  describe.each(surfaces.map((s) => [s.name, s] as const))('%s', (_n, s) => {
    const dir = join(REPO_ROOT, s.packageDir)
    const read = (rel: string) => readFileSync(join(dir, rel), 'utf8')
    const pubspec = load(read('pubspec.yaml')) as {
      name: string; version: string; environment: { sdk: string }
      dependencies: Record<string, string>; dev_dependencies: Record<string, string>
    }
    const spec = JSON.parse(readFileSync(join(REPO_ROOT, s.specFile), 'utf8')) as { info: { version: string } }

    it('pubspec name is gremion_<registry_name_snake>_client and version is the spec info.version', () => {
      expect(pubspec.name).toBe(s.pubName)
      expect(pubspec.name).toMatch(/^gremion_[a-z0-9_]+_client$/)
      expect(pubspec.version).toBe(spec.info.version)
      expect(pubspec.environment.sdk).toMatch(/<4\.0\.0/)
    })

    it('exposes its entry library lib/<pubName>.dart', () => {
      expect(existsSync(join(dir, 'lib', `${s.pubName}.dart`))).toBe(true)
      expect(read(`lib/${s.pubName}.dart`)).toMatch(/^export 'package:/m)
    })

    it('commits pubspec.lock, pinning every direct and dev dependency', () => {
      const lock = load(read('pubspec.lock')) as { packages: Record<string, { dependency: string; version: string }> }
      for (const dep of [...Object.keys(pubspec.dependencies), ...Object.keys(pubspec.dev_dependencies)]) {
        expect(lock.packages[dep], `${dep} not in pubspec.lock`).toBeDefined()
        expect(lock.packages[dep].dependency).toMatch(/^direct (main|dev)$/)
      }
    })

    it('enforces LF package-locally and ignores only pub caches', () => {
      expect(read('.gitattributes')).toMatch(/^\* text eol=lf$/m)
      expect(read('.gitignore').split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['.dart_tool/', 'build/'])
    })

    it('analysis_options.yaml neither excludes lib/** nor downgrades an error', () => {
      expect(checkAnalysisOptions(read('analysis_options.yaml'))).toEqual([])
    })

    it('ships no generated tests or docs', () => {
      expect(existsSync(join(dir, 'test'))).toBe(false)
      expect(existsSync(join(dir, 'doc'))).toBe(false)
    })
  })
})
