// @vitest-environment node
//
// TASK-028 intake round 3 (verify-r1/r2 HIGH 1), kept by TASK-041.
// docker-compose.prod.yml binds the app's DOMAIN ONCE, from PLATFORM_DOMAIN,
// with `:?` -- so every prod render aborts while PLATFORM_DOMAIN is unset.
// .env.example (what setup.sh and the verify stub copy to .env) must declare
// every `${KEY:?}` the prod overlay requires, non-empty.
//
// This block used to live in check-domain-regex-platform-domain.test.ts next
// to the probe-constant checks of check-domain-regex.mjs. TASK-041 deleted
// that script (the wildcard env key it guarded is gone), and with it the
// probe-constant block; this half is independent of it and stays.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

describe('.env.example carries every key the prod overlay requires', () => {
  const example = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8')
  const prod = readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8')
  const required = [
    ...new Set([...prod.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)].map((m) => m[1])),
  ]

  it('vacuity: the prod overlay requires PLATFORM_DOMAIN', () => {
    expect(required).toContain('PLATFORM_DOMAIN')
  })

  it('declares each required key with a non-empty value', () => {
    const missing = required.filter((k) => !new RegExp(`^${k}=\\S`, 'm').test(example))
    expect(missing).toEqual([])
  })

  it('derives PLATFORM_DOMAIN from DOMAIN, so the domain setup.sh writes is bound once', () => {
    // setup.sh rewrites only `DOMAIN=`; a literal PLATFORM_DOMAIN would keep
    // `localhost` after a real domain was entered and diverge from the edge.
    expect(example).toMatch(/^PLATFORM_DOMAIN=\$\{DOMAIN\}$/m)
  })
})
