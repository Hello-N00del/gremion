// src/lib/source-offer.wiring.test.ts
// source-offer.test.ts proves resolveSourceUrl() honours PUBLIC_SOURCE_URL. That
// is only half the AGPL-13 feature: the variable also has to REACH the running
// process. Both services take an explicit `environment:` allowlist rather than
// env_file, so a variable absent from the deployment manifests is not merely
// undocumented — it is unsettable, and every deployment then serves the upstream
// default as its Corresponding Source. For a fork that modified the program that
// offer is FALSE, which is exactly what source-offer.ts says must not happen.
//
// So the escape hatch is pinned to the surfaces an operator actually edits. Each
// case also asserts a sibling variable it ships next to: if a manifest is moved
// or its shape changes, the case fails loudly instead of passing vacuously.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8')

/**
 * The compose block for one service, from `  <name>:` to the next key that ends
 * it. The boundary is the next 2-space service key OR the next column-0 key
 * (`volumes:`, `networks:`), because the LAST service under `services:` has no
 * service key after it: bounded on 2-space keys alone its block ran past the end
 * of `services:` and swallowed the top-level `volumes:` header, so a case could
 * have been satisfied by text from an unrelated section.
 */
function composeService(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  expect(start, `docker-compose.yml has no "${name}" service`).toBeGreaterThan(-1)
  const rest = text.slice(start + 1)
  const next = rest.search(/\n(?: {2})?[a-z][a-z0-9-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('PUBLIC_SOURCE_URL is settable on every deployment surface', () => {
  it('docker-compose.yml passes it to gremion-ui', () => {
    const block = composeService(read('docker-compose.yml'), 'gremion-ui')
    expect(block, 'vacuity: the gremion-ui block lost its PUBLIC_BASE_URL sibling').toContain(
      'PUBLIC_BASE_URL:',
    )
    expect(block).toContain('PUBLIC_SOURCE_URL:')
  })

  it('docker-compose.yml passes it to gremion-public', () => {
    const block = composeService(read('docker-compose.yml'), 'gremion-public')
    expect(block, 'vacuity: the gremion-public block lost its PUBLIC_APEX_URL sibling').toContain(
      'PUBLIC_APEX_URL:',
    )
    expect(block).toContain('PUBLIC_SOURCE_URL:')
  })

  it('.env.example documents it', () => {
    const text = read('.env.example')
    expect(text, 'vacuity: .env.example lost its PUBLIC_BASE_URL sibling').toContain('PUBLIC_BASE_URL')
    // The VARIABLE, not the token: a `toContain` would be satisfied by the
    // explanatory paragraph above the line, so deleting the settable example
    // would not turn this red.
    expect(text, '.env.example carries no PUBLIC_SOURCE_URL= line').toMatch(
      /^#?\s*PUBLIC_SOURCE_URL=/m,
    )
  })

  it.each([
    ['k8s/base/gremion-ui/configmap.yaml'],
    ['k8s/base/gremion-public/configmap.yaml'],
  ])('%s carries it', (rel) => {
    const text = read(rel)
    expect(text, `vacuity: ${rel} lost its PUBLIC_BASE_URL sibling`).toContain('PUBLIC_BASE_URL')
    expect(text, `${rel} carries no PUBLIC_SOURCE_URL key`).toMatch(
      /^\s*PUBLIC_SOURCE_URL:/m,
    )
  })
})
