// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { runWithTenant } from '$lib/server/tenant/context'
import { tenantKey } from '$lib/server/files/namespace'
import { load } from './+layout.server'

// Every page under /files shows a group folder by its plain unit name: the key at the end of the mount point
// (" (<key>)") is handed down from the layout, one string per customer, no Nextcloud call.
const tenant = (id: string) => ({ id, slug: id }) as unknown as TenantContext
const run = () => (load as unknown as () => { mountSuffix: string })()

describe('LOAD /files layout: the customer key of the mount points', () => {
  it("is the current customer's own key, in the form the mount points end in", () => {
    expect(runWithTenant(tenant('tenant-a'), run).mountSuffix).toBe(` (${tenantKey('tenant-a')})`)
    expect(runWithTenant(tenant('tenant-b'), run).mountSuffix).toBe(` (${tenantKey('tenant-b')})`)
    expect(runWithTenant(tenant('tenant-a'), run).mountSuffix).not.toBe(runWithTenant(tenant('tenant-b'), run).mountSuffix)
  })

  it('is empty outside a customer scope: nothing is hidden from a name that carries no key', () => {
    expect(run().mountSuffix).toBe('')
  })
})
