/**
 * WP6-1 — phantom @gremion/db dependency guard for the content leaf.
 *
 * The content leaf declares `@gremion/ports` (the real shared kernel↔leaf
 * contract — imported across src/ and test/) but NOT `@gremion/db`: nothing in
 * the leaf imports `@gremion/db`, so it must not be declared.
 *
 * This guard fails if the phantom dep ever creeps back, and pins that the
 * genuine `@gremion/ports` coupling stays declared.
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

describe('WP6-1 — no phantom @gremion/db in the content leaf', () => {
  it('package.json declares no @gremion/db dependency', () => {
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    expect(Object.keys(allDeps)).not.toContain('@gremion/db')
  })

  it('Dockerfile references @gremion/db nowhere (no COPY, no comment)', () => {
    expect(dockerfile).not.toContain('@gremion/db')
    expect(dockerfile).not.toMatch(/packages\/db/)
  })

  it('the genuine @gremion/ports coupling stays declared in package.json', () => {
    expect(pkg.dependencies?.['@gremion/ports']).toBe('workspace:*')
  })
})
