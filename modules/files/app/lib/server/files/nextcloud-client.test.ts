import { describe, it, expect, vi } from 'vitest'
import { NextcloudClient } from './nextcloud-client'

function clientWithFetch(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl)
  return new NextcloudClient('http://nc', 'admin', 'pw')
}

describe('NextcloudClient group methods', () => {
  it('createGroup posts the group id to the OCS endpoint', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const c = clientWithFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) })
      return new Response('<ocs></ocs>', { status: 200 })
    }) as typeof fetch)
    await c.createGroup('ou-123')
    expect(calls[0].url).toContain('/ocs/v1.php/cloud/groups')
    expect(calls[0].body).toContain('groupid=ou-123')
  })

  it('addUserToGroup targets the user/groups OCS endpoint', async () => {
    const calls: string[] = []
    const c = clientWithFetch((async (url: string) => {
      calls.push(String(url))
      return new Response('<ocs></ocs>', { status: 200 })
    }) as typeof fetch)
    await c.addUserToGroup('user-1', 'ou-123')
    expect(calls[0]).toContain('/ocs/v1.php/cloud/users/user-1/groups')
  })
})

describe('NextcloudClient groupfolders methods', () => {
  it('createGroupFolder POSTs to index.php (not ocs/v2.php) and parses OCS-wrapped response', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = []
    const c = clientWithFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method), body: String(init.body) })
      return new Response(
        JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 100, message: 'OK', totalitems: '', itemsperpage: '' }, data: { id: 42, mount_point: 'StuRa/Finanzen', quota: -3, acl: false, acl_default_no_permission: false, size: 0, groups: [], group_details: [], manage: [] } } }),
        { status: 200 }
      )
    }) as typeof fetch)
    const result = await c.createGroupFolder('StuRa/Finanzen')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('/index.php/apps/groupfolders/folders')
    expect(calls[0].url).not.toContain('/ocs/v2.php/apps/groupfolders/')
    expect(result).toEqual({ id: 42, mountPoint: 'StuRa/Finanzen' })
  })

  it('assignGroupFolderPermissions first addGroup then setPermissions (two POST requests)', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const v21AddGroupResponse = JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 100, message: 'OK' }, data: { success: true, folder: { id: 42, mount_point: 'StuRa/Finanzen', quota: -3, acl: false, acl_default_no_permission: false, size: 0, groups: { 'ou-finanzen': 31 }, group_details: { 'ou-finanzen': { displayName: 'ou-finanzen', permissions: 31, type: 'group' } }, manage: [] } } } })
    const v21SetPermsResponse = JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 100, message: 'OK' }, data: { success: true, folder: { id: 42, mount_point: 'StuRa/Finanzen', quota: -3, acl: false, acl_default_no_permission: false, size: 0, groups: { 'ou-finanzen': 31 }, group_details: { 'ou-finanzen': { displayName: 'ou-finanzen', permissions: 31, type: 'group' } }, manage: [] } } } })
    let callIndex = 0
    const c = clientWithFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) })
      return new Response(callIndex++ === 0 ? v21AddGroupResponse : v21SetPermsResponse, { status: 200 })
    }) as typeof fetch)
    await c.assignGroupFolderPermissions(42, 'ou-finanzen', 31)
    // Must make exactly 2 requests
    expect(calls).toHaveLength(2)
    // Request 1: addGroup — POST /folders/{id}/groups with group= in body
    expect(calls[0].url).toContain('/index.php/apps/groupfolders/folders/42/groups')
    expect(calls[0].url).not.toMatch(/\/groups\/[^/]/)  // no group id in path
    expect(calls[0].body).toContain('group=ou-finanzen')
    // Request 2: setPermissions — POST /folders/{id}/groups/{group} with permissions= in body
    expect(calls[1].url).toContain('/index.php/apps/groupfolders/folders/42/groups/ou-finanzen')
    expect(calls[1].body).toContain('permissions=31')
    // Neither should use the OCS v2 path
    expect(calls[0].url).not.toContain('/ocs/v2.php/apps/groupfolders/')
    expect(calls[1].url).not.toContain('/ocs/v2.php/apps/groupfolders/')
  })

  it('deleteGroupFolder sends DELETE to index.php groupfolders route', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const v21DeleteResponse = JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 100, message: 'OK' }, data: { success: true } } })
    const c = clientWithFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method) })
      return new Response(v21DeleteResponse, { status: 200 })
    }) as typeof fetch)
    await c.deleteGroupFolder(42)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('/index.php/apps/groupfolders/folders/42')
    expect(calls[0].url).not.toContain('/ocs/v2.php/apps/groupfolders/')
  })
})

describe('NextcloudClient.provisionOidcUser', () => {
  it('POSTs the provider id and user details as JSON to the user_oidc OCS endpoint', async () => {
    const calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = []
    const c = clientWithFetch((async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init.method),
        body: String(init.body),
        headers: init.headers as Record<string, string>
      })
      return new Response(
        JSON.stringify({ ocs: { meta: { status: 'ok' }, data: { user_id: 'uuid-9' } } }),
        { status: 200 }
      )
    }) as typeof fetch)
    await c.provisionOidcUser({
      providerId: 1, userId: 'uuid-9', displayName: 'Max Muster', email: 'max@stura.de'
    })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('/ocs/v2.php/apps/user_oidc/api/v1/user')
    expect(calls[0].headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(calls[0].body)
    expect(body).toMatchObject({
      providerId: 1, userId: 'uuid-9', displayName: 'Max Muster', email: 'max@stura.de'
    })
  })
})
