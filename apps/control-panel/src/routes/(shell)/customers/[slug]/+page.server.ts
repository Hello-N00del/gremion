// One customer: its control row and, when configured, its provisioning ledger
// in EXECUTION_ORDER (the progress "Neuer Mandant" shows) -- and the state of
// its NEWEST request, which exists before the customer does (queued,
// verifying, running with its step, failed, refused). "Erneut versuchen" is a
// new request with a new idempotency key, only after failed/refused.
import { error, fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { describeRequest } from '$lib/request-state'
import { evidenceFromRequest } from '$lib/server/auth'
import { loadConfig } from '$lib/server/config'
import { customerRequests, customerStatus, platformDb } from '$lib/server/customers'
import { SubmitRefused } from '$lib/server/requests'
import { retryRequest } from '$lib/server/retry'
import type { Actions, PageServerLoad } from './$types'

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export const load: PageServerLoad = async ({ params }) => {
  if (!SLUG.test(params.slug) || params.slug.length > 30) error(404, 'no such customer')
  const r = loadConfig(env)
  if (!r.ok) error(503, 'the control panel is not configured')
  const status = await customerStatus(r.config, params.slug).catch((err: unknown) => {
    const e = err as { code?: string; message?: string }
    console.error(`[control-panel] customer status ${params.slug} failed: ${e?.code ?? 'no-sqlstate'}: ${e?.message ?? String(err)}`)
    error(503, 'the control registry or the platform ledger is not reachable (see the panel log)')
  })
  const requests = await customerRequests(r.config, params.slug).catch(() => [])
  const newest = requests[0]
  const latest = newest ? describeRequest(newest) : null
  return { slug: params.slug, status, requests, latest }
}

export const actions: Actions = {
  retry: async ({ params, request, locals }) => {
    if (!SLUG.test(params.slug) || params.slug.length > 30) error(404, 'no such customer')
    const r = loadConfig(env)
    if (!r.ok) error(503, 'the control panel is not configured')
    if (!locals.operator) error(403, 'not signed in through the ops realm')
    const p = platformDb(r.config)
    if (!p) return fail(409, { retryError: 'Keine Plattform-Datenbank konfiguriert: es kann keine Anfrage gestellt werden.' })
    const evidence = await evidenceFromRequest(request, r.config)
    if (!evidence) return fail(403, { retryError: 'Die Anmeldung trägt keinen Nachweis (loa2). Bitte neu anmelden.' })
    try {
      await retryRequest(p, params.slug, locals.operator.id, evidence)
    } catch (err) {
      if (err instanceof SubmitRefused) return fail(err.status, { retryError: err.message })
      throw err
    }
    redirect(303, `/customers/${params.slug}`)
  },
}
