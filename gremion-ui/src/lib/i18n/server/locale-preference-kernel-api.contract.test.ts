// TASK-080-a G11 — the LocalePreferencePort contract (testing/locale-preference-contract.ts)
// run against the kernel-api backend, over a fake kernel API that follows
// kernel-core.json: the person is found by the token's subject, a token with no
// person is the `no-person` 403, one row per (customer, person), row_version +1
// per write, the customer's default locale from its settings.
import { describe, expect, it } from 'vitest'
import { KernelApiLocalePreferencePort, KernelApiPreferenceError, type KernelApiSession } from './locale-preference-kernel-api'
import { createLocalePreferencePort, type CustomerDefaultLocale, type LocalePreferencePort } from './locale-preference-port'
import { forgetPersonId, personIdOf, rememberPersonId, resetPersonIdMapperForTest, usePersonIdMapper } from './person-id'
import { CONTRACT_IDS, describeLocalePreferenceContract } from './testing/locale-preference-contract'

const PROXY = 'proxy-trust-secret-for-the-contract-0123'
const { customerA, customerB, customerUnconfigured, person1 } = CONTRACT_IDS
const DEFAULTS: Record<string, CustomerDefaultLocale> = { [customerA]: 'en', [customerB]: 'de' }
const hostOf = (customerId: string) => `${customerId}.example.org`

/** The kernel API as gremion-ui sees it: only what kernel-core.json declares. */
function fakeKernelApi() {
  const rows = new Map<string, { locale: string; rowVersion: number; updatedBy: string }>()
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = []
  let outage: number | 'network' | null = null
  const problem = (status: number, type: string) => new Response(JSON.stringify({ type, title: 'x', status }), { status, headers: { 'content-type': 'application/problem+json' } })
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const handler = async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (outage === 'network') throw new TypeError('fetch failed')
    if (typeof outage === 'number') return problem(outage, 'urn:gremion:problem:customer-unavailable')
    if (headers['x-proxy-trust'] !== PROXY) return problem(403, 'urn:gremion:problem:forbidden')
    const customerId = [customerA, customerB, customerUnconfigured].find((c) => hostOf(c) === headers['x-forwarded-host'])
    const m = /^Bearer tok:([^:]*):(.*)$/.exec(headers.authorization ?? '')
    if (!customerId || !m || m[1] !== customerId) return problem(401, 'urn:gremion:problem:unauthorized')
    const person = m[2]!
    if (url.pathname === '/api/v1/customer/settings') return json({ defaultLocale: DEFAULTS[customerId] ?? 'de', formOfAddress: 'du', timeZone: 'Europe/Berlin' })
    if (url.pathname !== '/api/v1/persons/me/preference') return problem(404, 'urn:gremion:problem:not-found')
    if (person === 'anon' || person === 'nobody') return problem(403, 'urn:gremion:problem:no-person')
    const key = `${customerId}::${person}`
    if (init?.method === 'PUT') {
      const { locale } = JSON.parse(String(init.body)) as { locale: string }
      if (!['de', 'en', 'follow_customer'].includes(locale)) return problem(400, 'urn:gremion:problem:validation-failed')
      const prev = rows.get(key)
      rows.set(key, { locale, rowVersion: (prev?.rowVersion ?? 0) + 1, updatedBy: person })
    }
    const r = rows.get(key)
    const locale = r?.locale ?? 'follow_customer'
    return json({
      personId: person,
      locale,
      displayDensity: 'standard',
      colourScheme: 'system',
      lastBodyId: null,
      rowVersion: r?.rowVersion ?? 0,
      updatedByKind: r ? 'person' : 'system',
      updatedBy: r?.updatedBy ?? null,
      effectiveLocale: locale === 'follow_customer' ? (DEFAULTS[customerId] ?? 'de') : locale,
      stored: r !== undefined
    })
  }
  return { fetch: handler as typeof fetch, calls, setOutage: (o: number | 'network' | null) => (outage = o) }
}

const session = async (customerId: string, who: { personId?: string; subject?: string }): Promise<KernelApiSession> => ({
  host: hostOf(customerId),
  accessToken: `tok:${customerId}:${who.personId ?? who.subject ?? 'anon'}`
})

const make = (api = fakeKernelApi()): { port: LocalePreferencePort; api: ReturnType<typeof fakeKernelApi> } => ({
  port: createLocalePreferencePort({ backend: 'kernel-api', baseUrl: 'http://kernel-api-blue:3000', proxyTrust: PROXY, session, fetch: api.fetch }),
  api
})

describeLocalePreferenceContract('kernel-api', { fresh: async () => make().port })

describe('KernelApiLocalePreferencePort over the wire', () => {
  it('is the registered backend and sends the tenant proof on every call: whole host as host and x-forwarded-host, the proxy secret, the person bearer', async () => {
    const { port, api } = make()
    expect(port).toBeInstanceOf(KernelApiLocalePreferencePort)
    await port.set(customerA, person1, 'en')
    await port.get(customerA, person1)
    await port.getCustomerDefault(customerA)
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /api/v1/persons/me/preference', 'GET /api/v1/persons/me/preference', 'GET /api/v1/customer/settings'])
    for (const c of api.calls) {
      expect(c.headers.host).toBe(hostOf(customerA))
      expect(c.headers['x-forwarded-host']).toBe(hostOf(customerA))
      expect(c.headers['x-proxy-trust']).toBe(PROXY)
      expect(c.headers.authorization).toMatch(/^Bearer tok:/)
    }
    expect(api.calls[0]!.body).toEqual({ locale: 'en' }) // the person is NEVER in the body: the token names them
  })

  it('an unsupported locale never reaches the API', async () => {
    const { port, api } = make()
    await expect(port.set(customerA, person1, 'fr' as never)).rejects.toThrow(/locale/)
    expect(api.calls).toHaveLength(0)
  })

  it('a refusal or an outage is a KernelApiPreferenceError, never "no preference": wrong proxy secret, 503, a network error', async () => {
    const api = fakeKernelApi()
    const bad = createLocalePreferencePort({ backend: 'kernel-api', baseUrl: 'http://k:3000', proxyTrust: 'wrong', session, fetch: api.fetch })
    await expect(bad.get(customerA, person1)).rejects.toThrow(KernelApiPreferenceError)
    await expect(bad.get(customerA, person1)).rejects.toMatchObject({ status: 403 })
    const { port, api: api2 } = make()
    api2.setOutage(503)
    await expect(port.get(customerA, person1)).rejects.toMatchObject({ status: 503 })
    await expect(port.getCustomerDefault(customerA)).rejects.toThrow(KernelApiPreferenceError)
    api2.setOutage('network')
    await expect(port.set(customerA, person1, 'de')).rejects.toThrow(/unreachable/)
  })

  it('an undeclared answer (a wrong shape) is refused, not trusted', async () => {
    const port = createLocalePreferencePort({
      backend: 'kernel-api',
      baseUrl: 'http://k:3000',
      proxyTrust: PROXY,
      session,
      fetch: (async () => new Response(JSON.stringify({ locale: 'klingon' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    })
    await expect(port.get(customerA, person1)).rejects.toThrow(/contract does not declare/)
    await expect(port.getCustomerDefault(customerA)).rejects.toThrow(/contract does not declare/)
  })
})

describe('personIdOf: the real subject -> person mapping', () => {
  it('stays null until the kernel API resolved the subject; then answers from memory; forgets on request', async () => {
    resetPersonIdMapperForTest()
    const locals = { user: { id: 'kc-sub-1' } }
    expect(personIdOf(locals)).toBeNull() // the default is still noMappingYet
    usePersonIdMapper()
    expect(personIdOf(locals)).toBeNull() // bound, nothing resolved yet
    const port = new KernelApiLocalePreferencePort({ baseUrl: 'http://k:3000', proxyTrust: PROXY, session, fetch: make().api.fetch })
    const personId = await port.resolvePersonId(customerA, 'kc-sub-1')
    expect(personId).toBe('kc-sub-1') // the fake names the person after the token's last segment
    rememberPersonId('kc-sub-1', personId!)
    expect(personIdOf(locals)).toBe('kc-sub-1')
    expect(personIdOf({ user: null })).toBeNull()
    forgetPersonId('kc-sub-1')
    expect(personIdOf(locals)).toBeNull()
    expect(await port.resolvePersonId(customerA, 'nobody')).toBeNull() // the no-person 403 is "no person", not an error
    resetPersonIdMapperForTest()
  })
})
