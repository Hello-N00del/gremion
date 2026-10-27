// The CI placeholder file (compose/ci.placeholder.env) is the one place the
// render-only compose checks get values for `:?` variables a bare
// `cp .env.example .env` leaves unset. Two failure classes, both pinned here:
//   1. a compose file gains a required variable that neither .env.example (as an
//      ACTIVE assignment) nor the placeholder file supplies -> CI's render dies
//      with "required variable X is missing a value" (the TENANT_PROXY_SHARED_SECRET
//      break that took CI "Type check" and the G-037 guard down);
//   2. a placeholder that looks like a real secret lands in the public repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ciPlaceholderEnv, parsePlaceholderEnv, withCiPlaceholders } from './ci-placeholders.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

// Everything a render of these files interpolates with `:?` (a comment that
// merely shows the idiom, such as `${VAR:?...}`, is dropped by the name filter).
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.app.yml', 'docker-compose.app.dev.yml']
const requiredVars = new Set(
  COMPOSE_FILES.flatMap((f) => [...read(f).replace(/^\s*#.*$/gm, '').matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1])),
)
// Active (uncommented) assignments only: a `# NAME=` line does not set anything.
const activeInExample = new Set([...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))

test('the guard sees the required variables (not vacuous)', () => {
  assert.ok(requiredVars.size >= 10, `only ${requiredVars.size} found`)
  assert.ok(requiredVars.has('TENANT_PROXY_SHARED_SECRET'))
  assert.ok(requiredVars.has('IMAGE_TAG'))
})

test('every required compose variable has a source in .env.example (active) or compose/ci.placeholder.env', () => {
  const placeholders = ciPlaceholderEnv(ROOT)
  const unsourced = [...requiredVars].filter((v) => !activeInExample.has(v) && !(v in placeholders)).toSorted()
  assert.deepEqual(unsourced, [], `add these to compose/ci.placeholder.env (render-only placeholders): ${unsourced.join(', ')}`)
})

test('every placeholder is an obvious non-secret', () => {
  const placeholders = ciPlaceholderEnv(ROOT)
  assert.ok(Object.keys(placeholders).length >= 2)
  for (const [k, v] of Object.entries(placeholders)) {
    if (/SECRET|PASSWORD|TOKEN|KEY/.test(k)) assert.equal(v, 'ci-placeholder-not-a-secret', `${k} must be the literal placeholder`)
  }
})

test('placeholders only fill what the environment does not carry', () => {
  const filled = withCiPlaceholders({ TENANT_PROXY_SHARED_SECRET: 'operator-value' }, ROOT)
  assert.equal(filled.TENANT_PROXY_SHARED_SECRET, 'operator-value')
  assert.equal(filled.COLOUR, 'blue')
  const empty = withCiPlaceholders({ TENANT_PROXY_SHARED_SECRET: '' }, ROOT)
  assert.equal(empty.TENANT_PROXY_SHARED_SECRET, 'ci-placeholder-not-a-secret')
})

test('parsePlaceholderEnv skips comments and blank lines', () => {
  assert.deepEqual(parsePlaceholderEnv('# c\n\nA=1\r\nB=two\n'), { A: '1', B: 'two' })
})
