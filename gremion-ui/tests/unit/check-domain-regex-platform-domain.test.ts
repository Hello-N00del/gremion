// @vitest-environment node
//
// TASK-028 intake round 3 (verify-r1/r2 HIGH 1). docker-compose.prod.yml binds
// the app's DOMAIN ONCE, from PLATFORM_DOMAIN, with `:?` -- so every prod
// render aborts while PLATFORM_DOMAIN is unset. Two consumers must carry it:
//
//   - check-domain-regex.mjs's WIRING and CANARY probes are controlled,
//     env-independent renders: they set every key they depend on, so they
//     must set PLATFORM_DOMAIN too (they used to die on `PLATFORM_DOMAIN
//     required` on every set-up working copy, turning `pnpm check` red).
//     The ambient DEPLOY GUARD render stays faithful to the operator's env:
//     a real prod .env without PLATFORM_DOMAIN fails there, as its deploy would.
//   - .env.example (what setup.sh and the verify stub copy to .env) must
//     declare every `${KEY:?}` the prod overlay requires, non-empty.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CANARY_PROBE_ENV, WIRING_PROBE_ENV } from '../../scripts/check-domain-regex.mjs'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

describe('check-domain-regex probes control PLATFORM_DOMAIN', () => {
  it('the WIRING probe sets PLATFORM_DOMAIN to its own probe domain', () => {
    expect(WIRING_PROBE_ENV.PLATFORM_DOMAIN).toBeTruthy()
    expect(WIRING_PROBE_ENV.PLATFORM_DOMAIN).toBe(WIRING_PROBE_ENV.DOMAIN)
    expect(WIRING_PROBE_ENV.DOMAIN_REGEX).toBeTruthy()
  })

  it('the CANARY probe sets PLATFORM_DOMAIN to its own probe domain, and an EMPTY DOMAIN_REGEX', () => {
    expect(CANARY_PROBE_ENV.PLATFORM_DOMAIN).toBeTruthy()
    expect(CANARY_PROBE_ENV.PLATFORM_DOMAIN).toBe(CANARY_PROBE_ENV.DOMAIN)
    expect(CANARY_PROBE_ENV.DOMAIN_REGEX).toBe('')
  })

  it('the probe envs are frozen (a caller cannot mutate them into an uncontrolled render)', () => {
    expect(Object.isFrozen(WIRING_PROBE_ENV)).toBe(true)
    expect(Object.isFrozen(CANARY_PROBE_ENV)).toBe(true)
  })
})

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
