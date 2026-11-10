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

describe('NextcloudClient.deleteUser (TRD-196 erasure)', () => {
  it('DELETEs the OCS v2 user endpoint and reports true', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const c = clientWithFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method) })
      return new Response(JSON.stringify({ ocs: { meta: { statuscode: 200 } } }), { status: 200 })
    }) as typeof fetch)
    await expect(c.deleteUser('0b5f/user 1')).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('/ocs/v2.php/cloud/users/0b5f%2Fuser%201')
  })

  it('treats a 404 (account already gone) as success: false, so a re-run is idempotent', async () => {
    const c = clientWithFetch((async () => new Response('{}', { status: 404 })) as typeof fetch)
    await expect(c.deleteUser('gone')).resolves.toBe(false)
  })

  it('propagates any other failure', async () => {
    const c = clientWithFetch((async () => new Response('boom', { status: 500 })) as typeof fetch)
    await expect(c.deleteUser('u')).rejects.toThrow(/500/)
  })

  it('never deletes the admin account or an empty id, and does not call Nextcloud', async () => {
    const fetchSpy = vi.fn()
    const c = clientWithFetch(fetchSpy as unknown as typeof fetch)
    await expect(c.deleteUser('admin')).rejects.toThrow(/admin/)
    await expect(c.deleteUser('  ')).rejects.toThrow(/empty/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('NextcloudClient.listGroupMembers (Karenz p2 t16: retained sink membership sync)', () => {
  it('GETs the OCS group endpoint with an encoded id and returns the member ids', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const c = clientWithFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method) })
      return new Response(
        JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 100 }, data: { users: ['u-1', 'u-2'] } } }),
        { status: 200 }
      )
    }) as typeof fetch)
    await expect(c.listGroupMembers('gremion-retained-t 1')).resolves.toEqual(['u-1', 'u-2'])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toContain('/ocs/v1.php/cloud/groups/gremion-retained-t%201')
    expect(calls[0].url).toContain('format=json')
  })

  it('an empty group is an empty list', async () => {
    const c = clientWithFetch((async () =>
      new Response(JSON.stringify({ ocs: { meta: { statuscode: 100 }, data: { users: [] } } }), { status: 200 })) as typeof fetch)
    await expect(c.listGroupMembers('g')).resolves.toEqual([])
  })

  it('an OCS error envelope on HTTP 200 (group not found, 101) throws instead of reading as an empty group', async () => {
    const c = clientWithFetch((async () =>
      new Response(JSON.stringify({ ocs: { meta: { status: 'failure', statuscode: 101, message: 'The requested group could not be found' }, data: [] } }), { status: 200 })) as typeof fetch)
    await expect(c.listGroupMembers('g')).rejects.toThrow(/101/)
  })

  it('a body without a users list throws: an unreadable answer must not look like "nobody is in the group"', async () => {
    const c = clientWithFetch((async () => new Response(JSON.stringify({ ocs: { meta: { statuscode: 100 }, data: {} } }), { status: 200 })) as typeof fetch)
    await expect(c.listGroupMembers('g')).rejects.toThrow(/users/)
  })

  it('propagates an HTTP failure', async () => {
    const c = clientWithFetch((async () => new Response('boom', { status: 500 })) as typeof fetch)
    await expect(c.listGroupMembers('g')).rejects.toThrow(/500/)
  })
})

describe('NextcloudClient upload', () => {
  // Node's fetch builds a Request from the init; a ReadableStream body without `duplex: 'half'`
  // makes that constructor throw. The stub does exactly that construction, unmocked.
  const realRequestFetch = (async (url: string, init: RequestInit) => {
    new Request(url, init)
    return new Response(null, { status: 201 })
  }) as unknown as typeof fetch

  it('sends a ReadableStream body: the request init carries duplex half', async () => {
    const c = clientWithFetch(realRequestFetch)
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array([1, 2, 3]))
        ctl.close()
      }
    })
    await expect(c.upload('/remote.php/dav/files/u-1/a.pdf', 'u-1', body, 'application/pdf')).resolves.toBeUndefined()
  })

  it('a plain string body does not get a duplex option', async () => {
    const inits: RequestInit[] = []
    const c = clientWithFetch((async (_url: string, init: RequestInit) => {
      inits.push(init)
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch)
    await c.upload('/remote.php/dav/files/u-1/a.txt', 'u-1', 'hello', 'text/plain')
    expect('duplex' in inits[0]).toBe(false)
  })
})
