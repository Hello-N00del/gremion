import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The provisioner talks to Keycloak on its internal address. Without a frontendUrl on the ops
// realm, Keycloak builds the operator's invitation link from that address, which no browser can
// open. The customer realms carry theirs since TASK-043 r4; this holds the ops realm to the same.
const src = readFileSync(resolve(__dirname, '../../../../../scripts/tenant-provision.ts'), 'utf8')
const body = src.slice(src.indexOf('async function ensureOpsRealm'), src.indexOf('async function', src.indexOf('async function ensureOpsRealm') + 30))

describe('ops realm frontendUrl', () => {
  it('is set when the realm is created', () => {
    expect(body).toMatch(/doc\.attributes = \{[^}]*frontendUrl/)
  })

  it('is re-asserted on an existing realm, so a re-run of init repairs it', () => {
    const existing = body.slice(body.indexOf('if (have === fingerprint)'), body.indexOf('throw new ProvisioningError'))
    expect(existing).toMatch(/frontendUrl/)
    expect(existing).toMatch(/raw\('PUT', `\/admin\/realms\/\$\{OPS_REALM\}`/)
  })
})

// A realm that differs is refused with a reason that depends on what its control-panel client says. A client
// that could not be read must reach the refusal as an error (scripts/ops-realm-refusal.ts words it
// "could not be read"), not as an empty answer ("carries no redirect URI"): the read goes through
// readStoredPanelClient, whose result, error included, is what opsRealmRefusal is given. The function
// itself is held by scripts/ops-realm-refusal.test.ts; this holds the wiring (tenant-provision.ts runs
// main() on import, so it cannot be driven from a test).
describe('ops realm refusal wiring', () => {
  const differs = body.slice(body.indexOf('An ORIGIN mismatch'), body.indexOf('const secretPath'))

  it('reads the control-panel client through readStoredPanelClient and hands the whole result, the error included, to opsRealmRefusal', () => {
    expect(differs).toMatch(/const stored = await readStoredPanelClient\(raw, OPS_REALM\)/)
    expect(differs).toMatch(/opsRealmRefusal\(\{[^}]*\.\.\.stored[^}]*\}\)/)
  })

  it('does not read the client by hand (a hand-written read would swallow its failure)', () => {
    expect(differs).not.toMatch(/clients\?clientId=control-panel/)
    expect(differs).not.toMatch(/catch \(e\)/)
  })
})
