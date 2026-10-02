import { serviceEnv } from '$lib/server/env/service-env'
import { currentTenantId, getTenant } from '$lib/server/tenant/context'

// Thrown when Helios is reachable but returns an application-level error
// (e.g. duplicate short_name). Distinct from network errors (fetch throws).
export class HeliosAppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeliosAppError'
  }
}

// Thrown when a Helios election cannot be loaded because the external instance
// is unreachable (network/DNS/connection failure) or returns a "not there /
// not ready" status (404, or a transient 5xx). Lets callers degrade gracefully
// — render the local row we DO have rather than dropping it — instead of
// treating an external-service hiccup as a hard error.
export class HeliosUnavailableError extends Error {
  constructor(
    message: string,
    /** HTTP status when the request reached Helios; null on a network failure. */
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'HeliosUnavailableError'
  }
}

// Thrown when the Helios *service account* cannot authenticate or lacks admin
// rights — i.e. the password-backend login does not return its success 302, no
// session cookie is issued, or /helios/elections/new is not reachable as admin.
// This is a configuration/provisioning failure (commonly: the service account
// is absent after a clean-slate reseed), distinct from Helios being unreachable.
// The route maps it to a specific "service account not configured" diagnostic.
export class HeliosServiceAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeliosServiceAuthError'
  }
}

/**
 * Type guard: is this a "tracked-but-unreachable" failure we should degrade on,
 * rather than a real bug to surface? Covers our own HeliosUnavailableError plus
 * a bare network TypeError (fetch rejects with a TypeError when the host can't
 * be reached). Anything else is an unexpected error the caller may want to log.
 */
export function isHeliosUnavailable(e: unknown): boolean {
  if (e instanceof HeliosUnavailableError) return true
  // Undici/whatwg fetch throws a TypeError ("fetch failed") on connection
  // refused / DNS failure / TLS error — i.e. Helios is simply not reachable.
  return e instanceof TypeError
}

// ── Public types ────────────────────────────────────────────────────────────

export interface HeliosElection {
  uuid: string
  short_name: string
  name: string
  description: string
  voting_starts_at: string | null
  voting_ends_at: string | null
  frozen_at: string | null
  archived_at: string | null
  num_cast_votes: number
  result: unknown
  result_proof: unknown
}

export interface HeliosElectionFull extends HeliosElection {
  questions: Array<{
    question: string
    answers: string[]
    min: number
    max: number
    answer_type: string
  }> | null
  public_key: unknown
}

export interface CreateElectionInput {
  short_name: string
  name: string
  description: string
  voting_starts_at: string
  voting_ends_at: string
}

export interface HeliosQuestionInput {
  question: string
  short_name: string
  answer_type: 'approval'
  answers: string[]
  min: number
  max: number
}

export interface VoterInput {
  email: string
  name: string
}

export interface BulkUploadResult {
  num_voters: number
  warnings: string[]
}

export interface HeliosAnswerResult {
  answer: string
  count: number
}

export interface HeliosQuestionResult {
  question: string
  answers: string[]
  tally: number[]
  num_tallied: number
}

export interface HeliosResult {
  questions: HeliosQuestionResult[]
}

export interface HeliosVoter {
  uuid: string
  voter_login_id: string | null
  name: string
  cast_at: string | null
}

export type ElectionLifecycle = 'draft' | 'open' | 'closed'

export function deriveLifecycle(e: HeliosElection): ElectionLifecycle {
  if (e.frozen_at === null) return 'draft'
  if (e.voting_ends_at !== null && new Date(e.voting_ends_at) > new Date()) return 'open'
  return 'closed'
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// P2.1b T7: the Helios base URL resolves per tenant. The DEFAULT tenant keeps the
// HELIOS_URL env read byte-identically (services ignored); other tenants use their
// registry services.heliosUrl with env fallback until P2.1c provisioning. T14 §7.7:
// the default-tenant env read goes through the allowlisted serviceEnv seam.
// Fail-closed: outside a runWithTenant scope this throws (context.ts contract).
function heliosBase(): string {
  const ctx = getTenant()
  const svc = ctx.services
  return (svc?.heliosUrl ?? serviceEnv('HELIOS_URL') ?? 'http://helios:8000').replace(/\/$/, '')
}

/** Redirect statuses a browser (and undici) would follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** How many same-origin hops the read path will follow before giving up. */
const MAX_REDIRECT_HOPS = 2

async function heliosFetch<T>(path: string): Promise<T> {
  // Resolve the base OUTSIDE the try: a missing tenant context must surface as
  // the fail-closed throw, NOT be masked as a degraded HeliosUnavailableError.
  const base = heliosBase()
  const baseOrigin = new URL(base).origin
  let url = `${base}${path}`
  let res: Response
  let hops = 0
  for (;;) {
    try {
      // netcup T03 round 4 — this read path was the LAST fetch in the file still
      // on the default `redirect: 'follow'`. Round 3 pinned the cookie-carrying
      // ones and recorded them as "the last"; that was true only of the
      // cookie-carrying set. A Helios-controlled 302 here still drove a
      // server-side request to an arbitrary origin — and undici replays the
      // request on a same-site redirect, so any cookie the runtime attaches to a
      // Helios call would ride along.
      //
      // T03 round 5 — but `manual` ALONE broke the ordinary case: Django's
      // APPEND_SLASH answers this very path with a 301 to the slashed form, and
      // that 301 fell into the non-degradable `throw new Error` below, so a
      // healthy Helios made the elections page drop the row. The redirect is
      // now decided here instead of by undici: at most MAX_REDIRECT_HOPS hops,
      // and only to the SAME ORIGIN as the configured Helios base. The request
      // is re-issued by this function, so no header it does not build itself
      // (the service-account cookie included) can ride along, and an off-origin
      // Location is never dialled at all.
      res = await fetch(url, { redirect: 'manual' })
    } catch (e) {
      // fetch rejects (TypeError "fetch failed") when Helios is unreachable —
      // connection refused, DNS failure, TLS error. Surface as "unavailable" so
      // read callers can degrade instead of dropping the row.
      throw new HeliosUnavailableError(`Helios ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`, null)
    }
    if (!REDIRECT_STATUSES.has(res.status)) break

    const location = res.headers.get('location')
    if (!location) {
      // A 3xx with no Location is a broken hop, not a bug in our caller.
      throw new HeliosUnavailableError(`Helios ${path} → ${res.status} without Location`, res.status)
    }
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw new HeliosUnavailableError(`Helios ${path} → ${res.status} with unparseable Location`, res.status)
    }
    if (next.origin !== baseOrigin) {
      // Degradable, and NAMED: the operator log has to say where Helios tried
      // to send us, or an SSRF attempt reads as an ordinary outage.
      throw new HeliosUnavailableError(
        `Helios ${path} → ${res.status} redirected off-origin to ${next.origin}; refused`,
        res.status,
      )
    }
    if (++hops > MAX_REDIRECT_HOPS) {
      throw new HeliosUnavailableError(
        `Helios ${path} → too many redirects (> ${MAX_REDIRECT_HOPS})`,
        res.status,
      )
    }
    url = next.toString()
  }
  if (!res.ok) {
    // 404 (election not on this Helios instance) and 5xx (Helios down / not
    // ready) are reachability problems for a tracked row, not real bugs — flag
    // them so the page renders a degraded card rather than vanishing the row.
    if (res.status === 404 || res.status >= 500) {
      throw new HeliosUnavailableError(`Helios ${path} → ${res.status}`, res.status)
    }
    throw new Error(`Helios ${path} → ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ── Service account session (per-tenant cache, P2.1b T7) ────────────────────
// One Helios Django session + custom CSRF token per TENANT, keyed by the
// canonical tenant id: each tenant's Helios instance (or namespace) holds its
// own service-account session — sharing one cookie across tenants would replay
// tenant A's session against tenant B's base URL.

interface HeliosSession {
  /** `sessionid=<id>` cookie value sent on admin requests. */
  cookie: string
  // Helios custom CSRF: stored server-side in session, echoed back in HTML
  // hidden inputs. Fetched by GET /helios/elections/new after login and cached
  // for the session lifetime.
  csrf: string
}

const _sessionByTenant = new Map<string, HeliosSession>()

function extractCookie(header: string | null, name: string): string | null {
  if (!header) return null
  // set-cookie may be multi-value; search across all values
  const re = new RegExp(`(?:^|,)\\s*${name}=([^;,]+)`)
  return header.match(re)?.[1] ?? null
}

async function ensureSession(): Promise<HeliosSession> {
  const tenantId = currentTenantId()
  const cached = _sessionByTenant.get(tenantId)
  if (cached) return cached

  const username = serviceEnv('HELIOS_SERVICE_EMAIL') ?? ''
  const password = serviceEnv('HELIOS_SERVICE_PASSWORD') ?? ''
  const base = heliosBase()

  // Step 1: GET login page to get the csrftoken cookie (Django's own — needed for the login form)
  const getRes = await fetch(`${base}/auth/password/login`, { redirect: 'manual' })
  const getCookies = getRes.headers.get('set-cookie') ?? ''
  const djangoCsrfToken = extractCookie(getCookies, 'csrftoken') ?? ''

  // Step 2: POST login form
  const formBody = new URLSearchParams({ username, password, csrfmiddlewaretoken: djangoCsrfToken })
  const postRes = await fetch(`${base}/auth/password/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: djangoCsrfToken ? `csrftoken=${djangoCsrfToken}` : '',
      'X-CSRFToken': djangoCsrfToken,
      Referer: `${base}/auth/password/login`,
    },
    body: formBody.toString(),
    redirect: 'manual',
  })

  // Success is a 302 redirect to /auth/after
  if (postRes.status !== 302) {
    throw new HeliosServiceAuthError(`Helios service account login failed (${postRes.status}). Check HELIOS_SERVICE_EMAIL/PASSWORD.`)
  }

  const postCookies = postRes.headers.get('set-cookie') ?? ''
  const sessionId = extractCookie(postCookies, 'sessionid')
  if (!sessionId) {
    throw new HeliosServiceAuthError('Helios login: no sessionid cookie after POST. Check service account credentials.')
  }

  // Step 3: Follow redirect to /auth/after so Django sets session['user'].
  // netcup T03 — this fetch carries the freshly-minted service-account
  // `sessionid`. The Location comes from the response, so a compromised,
  // misconfigured or MITM'd Helios could aim it at 169.254.169.254 or any other
  // host and harvest an admin session. Pin it to the configured Helios origin
  // and fail closed (loudly) rather than silently falling back — an off-origin
  // login redirect is never a benign condition.
  const baseOrigin = new URL(base).origin
  const afterLocation = postRes.headers.get('location')
  let fullAfterUrl = `${base}/auth/after`
  if (afterLocation) {
    let afterOrigin: string | null = null
    try {
      const resolved = new URL(afterLocation, `${base}/`)
      afterOrigin = resolved.origin
      fullAfterUrl = resolved.toString()
    } catch {
      afterOrigin = null
    }
    if (afterOrigin !== baseOrigin) {
      throw new HeliosServiceAuthError(
        `Helios login redirected off-origin (${afterLocation}); refusing to send the service session there.`,
      )
    }
  }
  const afterRes = await fetch(fullAfterUrl, {
    headers: { Cookie: `sessionid=${sessionId}` },
    redirect: 'manual',
  })
  const afterCookies = afterRes.headers.get('set-cookie') ?? ''
  const finalSessionId = extractCookie(afterCookies, 'sessionid') ?? sessionId

  const cookie = `sessionid=${finalSessionId}`

  // Step 4: GET /helios/elections/new to trigger get_user() → establishes session['csrf_token']
  // and return the HTML which contains the CSRF token in a hidden input.
  const csrfPageRes = await fetch(`${base}/helios/elections/new`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  })
  if (csrfPageRes.status !== 200) {
    throw new HeliosServiceAuthError(`Helios elections/new returned ${csrfPageRes.status} — service account may lack admin_p.`)
  }
  const csrfHtml = await csrfPageRes.text()
  const csrfMatch = csrfHtml.match(/name="csrf_token" value="([^"]+)"/)
  if (!csrfMatch) {
    throw new HeliosServiceAuthError('Could not extract Helios CSRF token from elections/new page.')
  }
  const session: HeliosSession = { cookie, csrf: csrfMatch[1] }
  _sessionByTenant.set(tenantId, session)
  return session
}

/** Call only in tests to reset cached sessions between test cases. */
export function _resetSessionForTest(): void {
  _sessionByTenant.clear()
}

/** Drop a tenant's cached Helios service session (T8 evictTenantRuntime). */
export function evictHeliosSession(tenantId: string): void {
  _sessionByTenant.delete(tenantId)
}

async function heliosAdminFetch<T>(
  path: string,
  opts: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<T> {
  let session = await ensureSession()
  // netcup T03 round 3 — these two were the last cookie-carrying fetches in the
  // file that defaulted to `redirect: 'follow'`. A compromised, misconfigured or
  // MITM'd Helios answering an admin path with `302 Location: http://169.254.
  // 169.254/…` would have driven this server-side fetch off-origin with the
  // service-account session attached and returned the body to the caller. Pin
  // it AFTER the `...opts` spread so no caller can widen it back.
  const res = await fetch(`${heliosBase()}${path}`, {
    ...opts,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      ...opts.headers,
    },
  })

  // 401/403 means session expired — clear THIS tenant's session and retry once
  if (res.status === 401 || res.status === 403) {
    evictHeliosSession(currentTenantId())
    session = await ensureSession()
    const retry = await fetch(`${heliosBase()}${path}`, {
      ...opts,
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie,
        ...opts.headers,
      },
    })
    if (!retry.ok) throw new Error(`Helios admin ${path} → ${retry.status}`)
    return retry.json() as Promise<T>
  }

  if (!res.ok) throw new Error(`Helios admin ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

// Helios's custom CSRF: POST body must include csrf_token matching session['csrf_token'].
// Django's standard CsrfViewMiddleware is disabled in Helios settings.
async function heliosFormPost(path: string, params: URLSearchParams): Promise<Response> {
  let session = await ensureSession()
  params.set('csrf_token', session.csrf)
  const res = await fetch(`${heliosBase()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookie,
    },
    body: params.toString(),
    redirect: 'manual',
  })
  if (res.status === 401 || res.status === 403) {
    evictHeliosSession(currentTenantId())
    session = await ensureSession()
    params.set('csrf_token', session.csrf)
    return fetch(`${heliosBase()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookie,
      },
      body: params.toString(),
      redirect: 'manual',
    })
  }
  return res
}

// DateTimeLocalField expects YYYY-MM-DDTHH:MM (UTC, no seconds, no Z)
function toHeliosDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// ── Public API ───────────────────────────────────────────────────────────────

export const HeliosClient = {
  // Read methods (no session needed)
  getElection(uuid: string): Promise<HeliosElection> {
    return heliosFetch<HeliosElection>(`/helios/elections/${uuid}`)
  },

  getElectionFull(uuid: string): Promise<HeliosElectionFull> {
    return heliosFetch<HeliosElectionFull>(`/helios/elections/${uuid}`)
  },

  getResult(uuid: string): Promise<HeliosResult> {
    return heliosFetch<HeliosResult>(`/helios/elections/${uuid}/result`)
  },

  listVoters(uuid: string): Promise<readonly HeliosVoter[]> {
    return heliosAdminFetch<readonly HeliosVoter[]>(`/helios/elections/${uuid}/voters/`)
  },

  // Admin methods (service account session required)

  async createElection(data: CreateElectionInput): Promise<HeliosElection> {
    // Helios election_new is a Django HTML form view, not a JSON API.
    // On success it returns 302 to /helios/elections/<uuid>/view.
    const params = new URLSearchParams({
      short_name: data.short_name,
      name: data.name,
      description: data.description,
      election_type: 'election',
      voting_starts_at: toHeliosDateTime(data.voting_starts_at),
      voting_ends_at: toHeliosDateTime(data.voting_ends_at),
    })
    const res = await heliosFormPost('/helios/elections/new', params)
    if (res.status !== 302) {
      const body = await res.text().catch(() => '')
      // Try to extract a Django form error from the HTML (e.g. duplicate short_name)
      const formError = body.match(/class="errorlist"[^>]*>[\s\S]*?<li>([\s\S]*?)<\/li>/)
      const msg = formError
        ? formError[1].replace(/<[^>]+>/g, '').trim()
        : `Unerwartete Antwort von Helios (HTTP ${res.status})`
      throw new HeliosAppError(msg)
    }
    const location = res.headers.get('location') ?? ''
    // location: http://helios:8000/helios/elections/<uuid>/view
    const match = location.match(/\/elections\/([^/]+)\//)
    if (!match) throw new Error(`Helios createElection: can't extract UUID from location: ${location}`)
    return HeliosClient.getElection(match[1])
  },

  async setQuestions(uuid: string, questions: HeliosQuestionInput[]): Promise<void> {
    // Helios save_questions_safely requires answer_urls, choice_type, tally_type, result_type.
    const heliosQuestions = questions.map((q) => ({
      question: q.question,
      short_name: q.short_name,
      choice_type: q.answer_type,
      tally_type: 'homomorphic',
      result_type: 'absolute',
      answers: q.answers,
      answer_urls: q.answers.map(() => ''),
      min: q.min,
      max: q.max,
    }))
    // save_questions reads request.POST['questions_json'] (JSON-encoded array)
    const params = new URLSearchParams({
      questions_json: JSON.stringify(heliosQuestions),
    })
    const res = await heliosFormPost(`/helios/elections/${uuid}/save_questions`, params)
    if (!res.ok && res.status !== 200) {
      throw new Error(`Helios setQuestions → ${res.status}`)
    }
    const text = await res.text()
    if (text.trim() === 'FAILURE' || text.includes('FAILURE')) {
      throw new Error('Helios setQuestions: server returned FAILURE — check question format')
    }
  },

  async bulkUploadVoters(uuid: string, voters: VoterInput[]): Promise<BulkUploadResult> {
    // Two-step upload, then poll. Helios's confirm step dispatches an async
    // Celery task (voter_file_process); we MUST wait for it to finish before
    // the caller freezes the election, or freeze() sees 0 voters and 500s
    // with "cannot freeze an election that has issues".
    const session = await ensureSession()

    // No voters → skip the upload entirely. An empty CSV would create a
    // VoterFile with empty content and crash the Celery task.
    if (voters.length === 0) {
      return { num_voters: 0, warnings: [] }
    }

    // Helios CSV format: voter_type,voter_id,email,display_name
    // keycloak_oidc: voter_id == email (matches what Keycloak returns as user_id)
    const csv = voters.map((v) => `keycloak_oidc,${v.email},${v.email},${v.name}`).join('\n')
    const form = new FormData()
    form.append('voters_file', new Blob([csv], { type: 'text/csv' }), 'voters.csv')

    // Step 1: upload — Helios stores the file and puts voter_file_id in the session.
    const uploadRes = await fetch(`${heliosBase()}/helios/elections/${uuid}/voters/upload`, {
      method: 'POST',
      headers: { Cookie: session.cookie },
      body: form,
      redirect: 'manual',
    })
    if (uploadRes.status !== 200 && uploadRes.status !== 302) {
      throw new Error(`Helios voters upload step 1 → ${uploadRes.status}`)
    }

    // Step 2: confirm — same session carries voter_file_id; Helios dispatches
    // the async voter_file_process Celery task.
    const confirmForm = new URLSearchParams({ confirm_p: '1' })
    const confirmRes = await fetch(`${heliosBase()}/helios/elections/${uuid}/voters/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookie,
      },
      body: confirmForm.toString(),
      redirect: 'manual',
    })
    if (confirmRes.status !== 302 && confirmRes.status !== 200) {
      throw new Error(`Helios voters upload step 2 → ${confirmRes.status}`)
    }

    // Wait for the Celery task to actually insert the voters. Poll the voters
    // list until it is non-empty (or time out) — the caller freezes right after.
    const deadline = Date.now() + 30_000
    let processed = 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const current = await heliosAdminFetch<readonly unknown[]>(
          `/helios/elections/${uuid}/voters/`
        )
        if (current.length > 0) {
          processed = current.length
          break
        }
      } catch {
        // transient error — keep polling until the deadline
      }
    }
    if (processed === 0) {
      throw new Error(`Helios voter processing did not complete within 30s for ${uuid}`)
    }

    return { num_voters: processed, warnings: [] }
  },

  async freeze(uuid: string): Promise<void> {
    const res = await heliosFormPost(`/helios/elections/${uuid}/freeze`, new URLSearchParams())
    // freeze returns 302 (redirect to election view) when logged in as admin
    if (res.status !== 302 && res.status !== 200) {
      throw new Error(`Helios freeze → ${res.status}`)
    }
  },
}
