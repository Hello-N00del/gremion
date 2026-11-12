// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// E3 (finding 4): the status page named Caddy and federation, components that are
// not part of this deployment. The strings are gone from the route and from the
// shared status presentation it used to read them from; this guard keeps them out.
const here = import.meta.dirname

describe('systemstatus sources (E3)', () => {
  const files = [
    join(here, '+page.svelte'),
    join(here, '+page.server.ts'),
    join(here, 'signals.ts'),
    join(here, 'probes.server.ts'),
    join(here, '..', '..', 'lib', 'instance-status.ts'),
    join(here, '..', '..', 'lib', 'server', 'tenant', 'instance-state.ts'),
  ]

  it('names no Caddy or federation component', () => {
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/Caddy|Föderation/)
    }
  })

  it('has no canned convergence or waiting copy left in the route or its server code', () => {
    // instance-status.ts keeps the shell banner copy for the REAL boot readiness
    // state; the Systemstatus page does not read it any more.
    for (const f of files.filter((x) => !x.endsWith('instance-status.ts'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/Konvergiert noch|Wartet auf (Datenbank|Realm)/)
    }
  })
})
