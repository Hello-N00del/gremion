// @gremion/authz-client — the server-side client of the kernel API's PDP
// (TASK-081). A module (or the BFF acting for one) asks "may this person do this
// in this body?" and gets the kernel's single decision back; it never compares a
// role itself. HTTP only: no import of @gremion/events or any database package.
//
// Fail closed: any transport error, non-200 answer or malformed body throws
// AuthzClientError; callers treat a throw as DENY. The client never retries a
// decision into an allow and never caches one (Q9: the kernel reads the module
// registry per request, so a cache here would resurrect a disabled module).
//
// SERVER ONLY. The module secret must never reach a browser: do not import this
// from gremion-ui/gremion-public client code (see test/boundary.test.ts).

export interface DecisionRequest {
  /** the customer (tenant) the call is for: sent as x-tenant-id */
  customerId: string
  /** the verified token subject (idp subject) of the person acting */
  subject: string
  bodyId: string
  capability: string
  resource?: { kind: string; id: string }
}

export interface Decision {
  allow: boolean
  reason: string
  grantIds: string[]
}

export interface AuthzClientOptions {
  /** e.g. http://kernel-api:3000 */
  baseUrl: string
  /** this module's key, sent as x-gremion-module */
  moduleKey: string
  /** KERNEL_API_MODULE_SECRET_<ID> of this module */
  secret: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export class AuthzClientError extends Error {
  override name = 'AuthzClientError'
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createAuthzClient(opts: AuthzClientOptions) {
  if (!opts.baseUrl || !opts.moduleKey || !opts.secret) throw new TypeError('authz-client: baseUrl, moduleKey and secret are required')
  const doFetch = opts.fetch ?? fetch
  const url = new URL('/api/v1/authz/decisions', opts.baseUrl).toString()
  return {
    async decide(req: DecisionRequest): Promise<Decision> {
      if (!UUID.test(req.customerId) || !UUID.test(req.bodyId)) throw new AuthzClientError('customerId and bodyId must be uuids')
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gremion-module': opts.moduleKey, 'x-internal-auth': opts.secret, 'x-tenant-id': req.customerId },
          body: JSON.stringify({ subject: req.subject, bodyId: req.bodyId, capability: req.capability, ...(req.resource ? { resource: req.resource } : {}) }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        })
      } catch (err) {
        throw new AuthzClientError(`authz decision request failed: ${(err as Error).message}`)
      }
      if (res.status !== 200) throw new AuthzClientError(`authz decision answered ${res.status}`, res.status)
      const body = (await res.json().catch(() => null)) as Partial<Decision> | null
      if (!body || typeof body.allow !== 'boolean' || typeof body.reason !== 'string' || !Array.isArray(body.grantIds)) {
        throw new AuthzClientError('authz decision answer is malformed', 200)
      }
      return { allow: body.allow, reason: body.reason, grantIds: body.grantIds.map(String) }
    },
  }
}
