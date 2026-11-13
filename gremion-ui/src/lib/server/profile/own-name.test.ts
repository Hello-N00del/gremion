// Settings > Profil: the signed-in member edits THEIR OWN first and last name.
// The target user id comes only from the server-side session; the form body is
// read for exactly two fields.
import { describe, expect, test, vi } from 'vitest'
import { isActionFailure } from '@sveltejs/kit'
import { parseNameForm, saveOwnName, NAME_MAX, type OwnNameDeps } from './own-name'
import { Role } from '$lib/auth/types'

const member = { id: 'kc-uuid-1', email: 'anna@example.org', name: 'Anna Alt', roles: [Role.Member], groups: [], loa: 1, authTime: 0 }

function form(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

function event(fields: Record<string, string>, user: unknown = member) {
  return {
    request: new Request('https://pilot.test/settings?/profileName', { method: 'POST', body: new URLSearchParams(fields) }),
    locals: { user },
  }
}

function deps(over: Partial<OwnNameDeps> = {}): OwnNameDeps & { updateUserNames: ReturnType<typeof vi.fn> } {
  return { updateUserNames: vi.fn(async () => undefined), ...over } as never
}

describe('parseNameForm', () => {
  test('trims both names and accepts umlauts', () => {
    expect(parseNameForm(form({ firstName: '  Jürgen ', lastName: ' Müller-Lüdenscheid ' }))).toEqual({
      ok: true,
      firstName: 'Jürgen',
      lastName: 'Müller-Lüdenscheid',
    })
  })

  test.each([
    ['empty first name', { firstName: '', lastName: 'B' }, 'firstName'],
    ['blank first name', { firstName: '   ', lastName: 'B' }, 'firstName'],
    ['missing last name', { firstName: 'A' }, 'lastName'],
    ['control character', { firstName: 'A\u0007', lastName: 'B' }, 'firstName'],
    ['new line', { firstName: 'A', lastName: 'B\nC' }, 'lastName'],
    ['bidi override', { firstName: 'A\u202e', lastName: 'B' }, 'firstName'],
    ['line separator', { firstName: 'A', lastName: 'B\u2028' }, 'lastName'],
    ['lone surrogate', { firstName: 'A\ud800', lastName: 'B' }, 'firstName'],
    ['DEL', { firstName: 'A\u007f', lastName: 'B' }, 'firstName'],
    ['81 characters', { firstName: 'A'.repeat(NAME_MAX + 1), lastName: 'B' }, 'firstName'],
  ])('refuses %s', (_label, fields, badField) => {
    const r = parseNameForm(form(fields))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors)).toContain(badField)
  })

  test('80 characters is the longest accepted', () => {
    expect(parseNameForm(form({ firstName: 'A'.repeat(NAME_MAX), lastName: 'B' })).ok).toBe(true)
  })

  test('a file upload in place of a text field is refused, not coerced', () => {
    const f = new FormData()
    f.set('firstName', new File(['x'], 'x.txt'))
    f.set('lastName', 'B')
    expect(parseNameForm(f).ok).toBe(false)
  })
})

describe('saveOwnName', () => {
  test('writes the names of the SESSION user, nothing else', async () => {
    const d = deps()
    const out = await saveOwnName(event({ firstName: 'Anna Maria', lastName: 'Neu' }), d)
    expect(d.updateUserNames).toHaveBeenCalledTimes(1)
    expect(d.updateUserNames).toHaveBeenCalledWith('kc-uuid-1', { firstName: 'Anna Maria', lastName: 'Neu' })
    expect(out).toEqual({ profileName: { saved: true } })
  })

  test('a body carrying another user id and extra fields cannot change them', async () => {
    const d = deps()
    await saveOwnName(
      event({
        firstName: 'Anna',
        lastName: 'Neu',
        id: 'victim-uuid',
        userId: 'victim-uuid',
        sub: 'victim-uuid',
        email: 'evil@example.org',
        username: 'evil',
        enabled: 'false',
        attributes: '{"role":["admin"]}',
        requiredActions: 'UPDATE_PASSWORD',
      }),
      d,
    )
    expect(d.updateUserNames).toHaveBeenCalledTimes(1)
    const [id, names] = d.updateUserNames.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('kc-uuid-1')
    expect(Object.keys(names).sort()).toEqual(['firstName', 'lastName'])
  })

  test('the target id is not read from the URL either', async () => {
    const d = deps()
    const withQuery = {
      locals: { user: member },
      request: new Request('https://pilot.test/settings?/profileName&userId=victim-uuid', { method: 'POST', body: new URLSearchParams({ firstName: 'A', lastName: 'B' }) }),
    }
    await saveOwnName(withQuery, d)
    expect(d.updateUserNames.mock.calls[0]![0]).toBe('kc-uuid-1')
  })

  test.each([
    ['no session user', null],
    ['an empty id', { ...member, id: '' }],
    ['a user without the member role', { ...member, roles: [Role.Guest] }],
  ])('refuses %s without calling Keycloak', async (_l, user) => {
    const d = deps()
    const out = await saveOwnName(event({ firstName: 'A', lastName: 'B' }, user), d)
    expect(isActionFailure(out)).toBe(true)
    expect(d.updateUserNames).not.toHaveBeenCalled()
  })

  test('invalid names fail with 400, echo the values and never reach Keycloak', async () => {
    const d = deps()
    const out = await saveOwnName(event({ firstName: '', lastName: 'Neu' }), d)
    expect(isActionFailure(out)).toBe(true)
    expect(out).toMatchObject({ status: 400, data: { profileName: { error: 'invalid', values: { firstName: '', lastName: 'Neu' } } } })
    expect(d.updateUserNames).not.toHaveBeenCalled()
  })

  test('a Keycloak failure is an honest 503, never a success', async () => {
    const d = deps({ updateUserNames: vi.fn(async () => { throw new Error('Keycloak Admin API error: 500 secret detail') }) })
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = await saveOwnName(event({ firstName: 'A', lastName: 'B' }), d)
    expect(out).toMatchObject({ status: 503, data: { profileName: { error: 'not-saved' } } })
    expect(JSON.stringify(out)).not.toContain('secret detail')
    warn.mockRestore()
  })
})
