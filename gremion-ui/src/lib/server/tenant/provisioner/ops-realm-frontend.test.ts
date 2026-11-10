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
