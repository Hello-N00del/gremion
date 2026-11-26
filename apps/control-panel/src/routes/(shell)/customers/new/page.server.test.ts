// "Neuer Mandant" action (create-harden H1/H2): a form the panel can already
// see is bad is answered fail(400) on the form, and NOTHING is submitted (no
// plt.provisioning_request row); only a valid form reaches submitCreate.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const submitCreate = vi.fn(async () => 'req-1')
const ENV = vi.hoisted(() => ({}) as Record<string, string>)
vi.mock('$env/dynamic/private', () => ({ env: ENV }))
vi.mock('$lib/server/config', () => ({
  loadConfig: () => ({ ok: true, config: {} }),
  newCustomerDisabledReason: () => null,
}))
vi.mock('$lib/server/customers', () => ({ platformDb: () => ({}) }))
vi.mock('$lib/server/auth', () => ({
  evidenceFromRequest: async () => ({ token: 'x'.repeat(120), acr: 'loa2', authTime: new Date(), sessionAt: new Date() }),
}))
vi.mock('$lib/server/requests', async (orig) => ({
  ...(await orig<typeof import('$lib/server/requests')>()),
  submitCreate,
  heartbeatAgeSeconds: async () => 1,
  listModuleChoices: async () => [
    { id: 'calendar', name: 'Kalender', denied: null },
    { id: 'votes', name: 'Abstimmungen', denied: null },
  ],
}))

const { actions, load } = await import('./+page.server')

const KEY = '0192f0c4-0000-7000-8000-00000000000a'
const OP = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
const GOOD: Record<string, string | string[]> = {
  key: KEY,
  slug: 'proof-z',
  confirmSlug: 'proof-z',
  host: 'rat.proof.example',
  itAdmin: 'it@proof.example',
  councilAdmin: 'rat@proof.example',
  bodyName: 'Stadtrat',
  brandProduct: 'Rat',
  brandOrgShort: 'MS',
  enable: ['calendar'],
  dpia_calendar: 'no',
  dpiaRef_calendar: 'TOM-1',
}

async function post(fields: Record<string, string | string[] | undefined>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) body.append(k, one)
  }
  const request = new Request('http://127.0.0.1:3043/customers/new', { method: 'POST', body })
  try {
    const out = await actions.default!({ request, locals: { operator: { id: OP } } } as never)
    return { out, redirected: null as unknown }
  } catch (e) {
    return { out: null, redirected: e }
  }
}

function failed(r: Awaited<ReturnType<typeof post>>) {
  expect(r.redirected).toBeNull()
  const o = r.out as unknown as { status: number; data: { errors: Record<string, string> } }
  return o
}

beforeEach(() => {
  submitCreate.mockClear()
  delete ENV.PILOT_TENANT_HOST
  delete ENV.SECONDARY_TENANT_HOSTS
  delete ENV.SECONDARY_TENANT_MODULES
  delete ENV.PLATFORM_DOMAIN
  delete ENV.CONTROL_PANEL_HOST
})

describe('Neuer Mandant action: validation before any request row', () => {
  it('a valid form is submitted once and redirects', async () => {
    const r = await post(GOOD)
    expect(submitCreate).toHaveBeenCalledTimes(1)
    expect((r.redirected as { status?: number }).status).toBe(303)
  })

  it('H1: a brand with a control character is fail(400) on brandProduct and submits nothing', async () => {
    const o = failed(await post({ ...GOOD, brandProduct: 'Rat\u0007portal' }))
    expect(o.status).toBe(400)
    expect(o.data.errors.brandProduct).toMatch(/Zeichen/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('H1: a control character in the first body name or org short is refused the same way', async () => {
    const a = failed(await post({ ...GOOD, bodyName: 'Stadt\u0000rat' }))
    expect(a.data.errors.bodyName).toBeDefined()
    const b = failed(await post({ ...GOOD, brandOrgShort: 'M\nS' }))
    expect(b.data.errors.brandOrgShort).toBeDefined()
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('the two semester start months reach submitCreate as numbers; a form without them submits none', async () => {
    await post({ ...GOOD, termWinterMonth: '10', termSummerMonth: '4' })
    expect(submitCreate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ termWinterMonth: 10, termSummerMonth: 4 }), OP, KEY, expect.anything())
    submitCreate.mockClear()
    await post(GOOD)
    const input = (submitCreate.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]
    expect(input.termWinterMonth).toBeUndefined()
    expect(input.termSummerMonth).toBeUndefined()
  })

  it('equal or malformed months are fail(400) on termMonths, the chosen values come back, nothing is submitted', async () => {
    const equal = failed(await post({ ...GOOD, termWinterMonth: '4', termSummerMonth: '4' }))
    expect(equal.status).toBe(400)
    expect(equal.data.errors.termMonths).toMatch(/Semester/)
    expect((equal as unknown as { data: { values: Record<string, unknown> } }).data.values.termWinterMonth).toBe(4)
    expect(failed(await post({ ...GOOD, termWinterMonth: '13', termSummerMonth: '4' })).data.errors.termMonths).toBeDefined()
    expect(failed(await post({ ...GOOD, termWinterMonth: 'oktober', termSummerMonth: '4' })).data.errors.termMonths).toBeDefined()
    expect(failed(await post({ ...GOOD, termWinterMonth: '10' })).data.errors.termMonths).toBeDefined()
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('H1: a non-ASCII (IDN) host is refused with German text, nothing is submitted', async () => {
    const o = failed(await post({ ...GOOD, host: 'rät.müller.de' }))
    expect(o.status).toBe(400)
    expect(o.data.errors.host).toMatch(/ASCII|Punycode/i)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('H2: an enabled module with no DPIA answer is a dpia form error, nothing is submitted', async () => {
    const o = failed(await post({ ...GOOD, dpia_calendar: undefined }))
    expect(o.status).toBe(400)
    expect(o.data.errors.dpia).toMatch(/calendar/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('H2: an unknown DPIA answer is not read as "no"', async () => {
    const o = failed(await post({ ...GOOD, dpia_calendar: 'maybe' }))
    expect(o.data.errors.dpia).toMatch(/calendar/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('H2: yes without a document reference is a dpia form error, nothing is submitted', async () => {
    const o = failed(await post({ ...GOOD, dpia_calendar: 'yes', dpiaRef_calendar: '  ' }))
    expect(o.status).toBe(400)
    expect(o.data.errors.dpia).toMatch(/calendar/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('H2: explicit yes with a reference and explicit no with a reference are both submitted', async () => {
    await post({ ...GOOD, dpia_calendar: 'yes' })
    await post({ ...GOOD, dpia_calendar: 'no' })
    expect(submitCreate).toHaveBeenCalledTimes(2)
  })

  it('MED-2: an enable id that is not a toggleable module row is refused even in a hand-made POST', async () => {
    const o = failed(await post({ ...GOOD, enable: ['calendar', 'ghost'], dpia_ghost: 'no', dpiaRef_ghost: 'TOM-9' }))
    expect(o.status).toBe(400)
    expect(o.data.errors.enable).toMatch(/ghost/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('LOW-1: a non-ASCII host that folds to ASCII when lower-cased (Kelvin sign) is refused', async () => {
    const o = failed(await post({ ...GOOD, host: 'rat.\u212Aeller.de' }))
    expect(o.data.errors.host).toMatch(/ASCII/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('HIGH-1: the answers of an unticked module survive a failed submit', async () => {
    const o = failed(await post({ ...GOOD, brandProduct: 'a\u0007', dpia_votes: 'yes', dpiaRef_votes: 'TOM-7' }))
    const dpia = (o as unknown as { data: { values: { dpia: Record<string, { requiresDpia: boolean | null; documentRef: string }> } } }).data.values.dpia
    expect(dpia.votes).toEqual({ requiresDpia: true, documentRef: 'TOM-7' })
  })

  it('HIGH-2: a reserved slug is refused on the form', async () => {
    const o = failed(await post({ ...GOOD, slug: 'keycloak' }))
    expect(o.data.errors.slug).toBeDefined()
    expect(submitCreate).not.toHaveBeenCalled()
  })
})

describe('Neuer Mandant: the control panel host is no customer host (the action reads it from the panel env)', () => {
  it('the configured custom host (outside the platform domain) is a host field error, nothing is submitted', async () => {
    ENV.PLATFORM_DOMAIN = 'platform.proof.example'
    ENV.CONTROL_PANEL_HOST = 'panel.proof.example'
    const o = failed(await post({ ...GOOD, host: 'panel.proof.example' }))
    expect(o.status).toBe(400)
    expect(o.data.errors.host).toMatch(/reserviert/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('the default control.<platform> stays refused with no CONTROL_PANEL_HOST set', async () => {
    ENV.PLATFORM_DOMAIN = 'platform.proof.example'
    const o = failed(await post({ ...GOOD, host: 'control.platform.proof.example' }))
    expect(o.data.errors.host).toMatch(/reserviert/)
    expect(submitCreate).not.toHaveBeenCalled()
  })

  it('another host is still submitted when the panel host is configured', async () => {
    ENV.PLATFORM_DOMAIN = 'platform.proof.example'
    ENV.CONTROL_PANEL_HOST = 'panel.proof.example'
    await post(GOOD)
    expect(submitCreate).toHaveBeenCalledTimes(1)
  })
})

describe('Neuer Mandant: the slug typed twice and the expected host', () => {
  it('T12: a repeated slug that differs is fail(400) on confirmSlug and submits nothing', async () => {
    const o = failed(await post({ ...GOOD, confirmSlug: 'proof-y' }))
    expect(o.status).toBe(400)
    expect(o.data.errors.confirmSlug).toMatch(/Kurzname/)
    expect(submitCreate).not.toHaveBeenCalled()
  })
  it('T12: a missing or blank repeated slug (a hand-made POST) is refused the same way', async () => {
    expect(failed(await post({ ...GOOD, confirmSlug: undefined })).data.errors.confirmSlug).toBeDefined()
    expect(failed(await post({ ...GOOD, confirmSlug: '   ' })).data.errors.confirmSlug).toBeDefined()
    expect(submitCreate).not.toHaveBeenCalled()
  })
  it('T12: the typed slug is kept on the re-rendered form, the confirmation is not read as the slug', async () => {
    const o = failed(await post({ ...GOOD, confirmSlug: 'proof-y' })) as unknown as { data: { values: { slug: string } } }
    expect(o.data.values.slug).toBe('proof-z')
    expect(submitCreate).not.toHaveBeenCalled()
  })
  it('T12: the load names the install host from PILOT_TENANT_HOST; unset or a placeholder: no hint', async () => {
    const run = () => (load as unknown as (e: unknown) => Promise<{ expectedHost: string | null }>)({})
    expect((await run()).expectedHost).toBeNull()
    ENV.PILOT_TENANT_HOST = 'CHANGE_ME_OPERATOR_pilot_tenant_host'
    expect((await run()).expectedHost).toBeNull()
    ENV.PILOT_TENANT_HOST = 'Rat.Proof.Example'
    expect((await run()).expectedHost).toBe('rat.proof.example')
  })
})

describe('Neuer Mandant: the secondary customer hosts (SECONDARY_TENANT_HOSTS, passed in like PILOT_TENANT_HOST)', () => {
  const secondary = async () => (await (load as unknown as (e: unknown) => Promise<{ secondaryHosts: string[] }>)({})).secondaryHosts

  it('S1: unset or empty: no secondary hosts', async () => {
    expect(await secondary()).toEqual([])
    ENV.SECONDARY_TENANT_HOSTS = ''
    expect(await secondary()).toEqual([])
    ENV.SECONDARY_TENANT_HOSTS = '  ,  '
    expect(await secondary()).toEqual([])
  })

  it('S2: the load names the listed hosts, lower case, in the order of the list', async () => {
    ENV.PILOT_TENANT_HOST = 'rat.proof.example'
    ENV.SECONDARY_TENANT_HOSTS = 'canary.example.org,Test.Example.Net'
    expect(await secondary()).toEqual(['canary.example.org', 'test.example.net'])
  })

  it('S3: an entry that is no host name, a repeated entry and the customer host itself are not shown', async () => {
    ENV.PILOT_TENANT_HOST = 'rat.proof.example'
    ENV.SECONDARY_TENANT_HOSTS = 'https://evil.example.org,canary.example.org,canary.example.org,rat.proof.example,*.example.org,x'
    expect(await secondary()).toEqual(['canary.example.org'])
  })

  it('S4: the panel does not enforce the list: the form is validated as before and the host-side create decides', async () => {
    ENV.SECONDARY_TENANT_HOSTS = 'canary.example.org'
    await post({ ...GOOD, host: 'canary.example.org' })
    expect(submitCreate).toHaveBeenCalledTimes(1)
    submitCreate.mockClear()
    await post({ ...GOOD, host: 'other.example.org' })
    expect(submitCreate).toHaveBeenCalledTimes(1)
  })

  it('S5: the list is read from the panel environment only, never from the posted form', async () => {
    ENV.PILOT_TENANT_HOST = 'rat.proof.example'
    const run = (load as unknown as (e: unknown) => Promise<{ secondaryHosts: string[] }>)
    const r = await run({ url: new URL('http://127.0.0.1:3043/customers/new?SECONDARY_TENANT_HOSTS=evil.example.org') })
    expect(r.secondaryHosts).toEqual([])
  })
})

describe('Neuer Mandant: the opted-in modules of a secondary host (SECONDARY_TENANT_MODULES, passed in like SECONDARY_TENANT_HOSTS)', () => {
  const modules = async () => (await (load as unknown as (e: unknown) => Promise<{ secondaryModules: string[] }>)({})).secondaryModules

  it('M1: unset or empty: no opted-in modules', async () => {
    expect(await modules()).toEqual([])
    ENV.SECONDARY_TENANT_MODULES = ''
    expect(await modules()).toEqual([])
    ENV.SECONDARY_TENANT_MODULES = '   '
    expect(await modules()).toEqual([])
  })

  it('M2: the load names the opted-in ids of the fixed set, in the order of the list', async () => {
    ENV.SECONDARY_TENANT_MODULES = 'votes files'
    expect(await modules()).toEqual(['votes', 'files'])
    ENV.SECONDARY_TENANT_MODULES = '  messaging   files '
    expect(await modules()).toEqual(['messaging', 'files'])
  })

  it('M3: an id outside the set (elections, vault, finance, handover, an unknown or upper-case one) and a repeat are not shown', async () => {
    ENV.SECONDARY_TENANT_MODULES = 'elections files vault files Votes some-new-module messages finance handover'
    expect(await modules()).toEqual(['files'])
  })

  it('M3b: content and publishing are in the set, in the order of the list', async () => {
    ENV.SECONDARY_TENANT_MODULES = 'publishing files content files'
    expect(await modules()).toEqual(['publishing', 'files', 'content'])
  })

  it('M4: the opt-in is read from the panel environment only, never from the posted form or the URL', async () => {
    const run = (load as unknown as (e: unknown) => Promise<{ secondaryModules: string[] }>)
    const r = await run({ url: new URL('http://127.0.0.1:3043/customers/new?SECONDARY_TENANT_MODULES=files') })
    expect(r.secondaryModules).toEqual([])
  })
})
