// TASK-080-a G11 (lane note C8) — the kernel-api backend of LocalePreferencePort.
//
// The idt tables belong to the kernel API (TASK-080): gremion-ui no longer
// issues SQL against idt.preference / idt.customer_setting, it asks the API as the
// SIGNED-IN PERSON:
//   get()                 GET /api/v1/persons/me/preference   (the person is found by the token's verified `sub`)
//   set()                 PUT /api/v1/persons/me/preference
//   getCustomerDefault()  GET /api/v1/customer/settings
// Authentication is the caller's: `session(customerId, who)` hands back the
// customer's public host (the kernel API resolves the tenant from the WHOLE
// x-forwarded-host, equal to Host) and the person's access token. The proxy-trust
// secret travels with every call. Nothing here reads a cookie or a session.
//
// Failure model (the cookie/customer default still decides when this is down):
//   * 403 `no-person` on get()  -> null (a valid token, no person row: "no preference");
//   * every other non-2xx, a network error or an undeclared body -> KernelApiPreferenceError
//     (never swallowed into null: a wrong proxy secret must not look like "no preference").
//
// The wire types below restate the kernel-core.json schemas this adapter reads
// (Preference, CustomerSettings); packages/generated-clients/src/generated/
// kernel-core-client.ts is their generated twin. gremion-ui does not depend on that
// package yet, so the shapes are checked at run time instead (parsePreference).
import type { CustomerDefaultLocale, LocalePreferencePort, LocalePreferenceRow, PersonLocale } from './locale-preference-port'

const PERSON_LOCALES: readonly PersonLocale[] = ['de', 'en', 'follow_customer']
const NO_PERSON = 'urn:gremion:problem:no-person'

export interface KernelApiSession {
  /** The customer's public host (sent as x-forwarded-host AND host). */
  host: string
  /** The person's access token (audience gremion-kernel-api). */
  accessToken: string
}

export interface KernelApiWho {
  personId?: string
  subject?: string
}

export interface KernelApiLocaleConfig {
  /** http://kernel-api-<colour>:3000 */
  baseUrl: string
  /** TENANT_PROXY_SHARED_SECRET */
  proxyTrust: string
  session(customerId: string, who: KernelApiWho): Promise<KernelApiSession>
  /** Test seam; defaults to globalThis.fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
}

export class KernelApiPreferenceError extends Error {
  override name = 'KernelApiPreferenceError'
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

interface WirePreference {
  personId: string
  locale: PersonLocale
  rowVersion: number
  updatedByKind: 'person' | 'system'
  updatedBy: string | null
  effectiveLocale: CustomerDefaultLocale
  stored: boolean
}

function parsePreference(body: unknown): WirePreference {
  const b = body as Partial<WirePreference> | null
  if (
    !b ||
    typeof b.personId !== 'string' ||
    !PERSON_LOCALES.includes(b.locale as PersonLocale) ||
    typeof b.rowVersion !== 'number' ||
    (b.updatedByKind !== 'person' && b.updatedByKind !== 'system') ||
    (b.effectiveLocale !== 'de' && b.effectiveLocale !== 'en') ||
    typeof b.stored !== 'boolean'
  ) {
    throw new KernelApiPreferenceError('the kernel API answered a preference the contract does not declare')
  }
  return b as WirePreference
}

const toRow = (p: WirePreference): LocalePreferenceRow => ({ locale: p.locale, rowVersion: p.rowVersion, updatedByKind: p.updatedByKind, updatedBy: p.updatedBy })

export class KernelApiLocalePreferencePort implements LocalePreferencePort {
  constructor(private readonly cfg: KernelApiLocaleConfig) {}

  private async call(customerId: string, who: KernelApiWho, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const s = await this.cfg.session(customerId, who)
    const doFetch = this.cfg.fetch ?? fetch
    let res: Response
    try {
      res = await doFetch(new URL(path, this.cfg.baseUrl), {
        method,
        headers: {
          host: s.host,
          'x-forwarded-host': s.host,
          'x-proxy-trust': this.cfg.proxyTrust,
          authorization: `Bearer ${s.accessToken}`,
          accept: 'application/json, application/problem+json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 5_000)
      })
    } catch (err) {
      throw new KernelApiPreferenceError(`the kernel API is unreachable: ${(err as Error).message}`)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      /* no body */
    }
    return { status: res.status, json }
  }

  async get(customerId: string, personId: string): Promise<LocalePreferenceRow | null> {
    const r = await this.call(customerId, { personId }, 'GET', '/api/v1/persons/me/preference')
    if (r.status === 403 && (r.json as { type?: string } | null)?.type === NO_PERSON) return null
    if (r.status !== 200) throw new KernelApiPreferenceError(`GET preference answered ${r.status}`, r.status)
    const p = parsePreference(r.json)
    return p.stored ? toRow(p) : null
  }

  async set(customerId: string, personId: string, locale: PersonLocale): Promise<LocalePreferenceRow> {
    // Mirrors preference_locale_check: an unknown value is refused here, before any call.
    if (!PERSON_LOCALES.includes(locale)) throw new Error(`unsupported locale preference '${String(locale)}'`)
    const r = await this.call(customerId, { personId }, 'PUT', '/api/v1/persons/me/preference', { locale })
    if (r.status !== 200) throw new KernelApiPreferenceError(`PUT preference answered ${r.status}`, r.status)
    return toRow(parsePreference(r.json))
  }

  async getCustomerDefault(customerId: string): Promise<CustomerDefaultLocale> {
    const r = await this.call(customerId, {}, 'GET', '/api/v1/customer/settings')
    if (r.status !== 200) throw new KernelApiPreferenceError(`GET customer settings answered ${r.status}`, r.status)
    const d = (r.json as { defaultLocale?: unknown } | null)?.defaultLocale
    if (d !== 'de' && d !== 'en') throw new KernelApiPreferenceError('the kernel API answered customer settings the contract does not declare')
    return d
  }

  /** The idt.person_id the signed-in subject maps to, or null (no person). Feeds personIdOf's map. */
  async resolvePersonId(customerId: string, subject: string): Promise<string | null> {
    const r = await this.call(customerId, { subject }, 'GET', '/api/v1/persons/me/preference')
    if (r.status === 403 && (r.json as { type?: string } | null)?.type === NO_PERSON) return null
    if (r.status !== 200) throw new KernelApiPreferenceError(`GET preference answered ${r.status}`, r.status)
    return parsePreference(r.json).personId
  }
}
