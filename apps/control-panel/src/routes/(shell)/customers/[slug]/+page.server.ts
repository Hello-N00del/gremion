// One customer: its control row and, when configured, its provisioning ledger
// in EXECUTION_ORDER (the progress "Neuer Mandant" shows).
import { error } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { loadConfig } from '$lib/server/config'
import { customerStatus } from '$lib/server/customers'
import type { PageServerLoad } from './$types'

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
  if (!status) return { slug: params.slug, status: null }
  return { slug: params.slug, status }
}
