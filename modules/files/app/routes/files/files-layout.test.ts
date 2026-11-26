// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { runWithTenant } from '$lib/server/tenant/context'
import { crumbsFor } from '$lib/components/layout/crumbs'
import { tenantKey } from '$lib/server/files/namespace'
import { load } from './+layout.server'

// Every page under /files shows a group folder by its plain unit name: the key at the end of the mount point
// (" (<key>)") is handed down from the layout, one string per customer, no Nextcloud call. The top bar names
// the same folder from the URL, so the layout also names that segment.
const tenant = (id: string) => ({ id, slug: id }) as unknown as TenantContext
type Out = { mountSuffix: string; crumbOverrides: Record<string, string | null> }
const run = (path = '/files') => (load as unknown as (e: { url: URL }) => Out)({ url: new URL(`http://localhost${path}`) })

describe('LOAD /files layout: the customer key of the mount points', () => {
  it("is the current customer's own key, in the form the mount points end in", () => {
    expect(runWithTenant(tenant('tenant-a'), () => run()).mountSuffix).toBe(` (${tenantKey('tenant-a')})`)
    expect(runWithTenant(tenant('tenant-b'), () => run()).mountSuffix).toBe(` (${tenantKey('tenant-b')})`)
    expect(runWithTenant(tenant('tenant-a'), () => run()).mountSuffix).not.toBe(runWithTenant(tenant('tenant-b'), () => run()).mountSuffix)
  })

  it('is empty outside a customer scope: nothing is hidden from a name that carries no key', () => {
    expect(run().mountSuffix).toBe('')
  })
})

describe('LOAD /files layout: the top bar names a group folder by the unit name', () => {
  const KEY = tenantKey('tenant-a')
  const inA = (path: string) => runWithTenant(tenant('tenant-a'), () => run(path))
  const crumbs = (path: string) => crumbsFor({ pathname: path, routeId: '/files/[...path]', overrides: inA(path).crumbOverrides })

  it('shows the plain name for the folder in the URL and keeps the names below it', () => {
    const path = `/files/${encodeURIComponent(`Vorstand (${KEY})`)}/Protokolle`
    expect(crumbs(path)).toEqual(['Dokumente', 'Vorstand', 'Protokolle'])
  })

  it('does the same in the editor route, where the group folder is the second segment', () => {
    const path = `/files/edit/${encodeURIComponent(`Vorstand (${KEY})`)}/Protokolle/Sitzung.odt`
    expect(crumbs(path)).toEqual(['Dokumente', 'Bearbeiten', 'Vorstand', 'Protokolle', 'Sitzung.odt'])
  })

  it('leaves a folder without the key, the root and another customer\'s key as they are', () => {
    expect(crumbs('/files/Vorstand/Protokolle')).toEqual(['Dokumente', 'Vorstand', 'Protokolle'])
    expect(crumbs('/files')).toEqual(['Dokumente'])
    const other = `/files/${encodeURIComponent(`Vorstand (${tenantKey('tenant-b')})`)}`
    expect(crumbs(other)).toEqual(['Dokumente', `Vorstand (${tenantKey('tenant-b')})`])
  })
})
