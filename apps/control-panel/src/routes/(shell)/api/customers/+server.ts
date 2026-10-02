// GET /api/customers — the list as JSON, behind the same gate as every page
// (hooks.server.ts decides before an endpoint runs; TDD 15 probes this one).
import { error, json } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { loadConfig } from '$lib/server/config'
import { listCustomers } from '$lib/server/customers'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.operator) error(403, 'not signed in through the ops realm')
  const r = loadConfig(env)
  if (!r.ok) error(503, 'the control panel is not configured')
  return json(await listCustomers(r.config), { headers: { 'cache-control': 'no-store' } })
}
