// /healthz — the process and a valid configuration ONLY. It never reaches
// Keycloak or a database, so the panel is healthy before `gremion-tenant init`
// (the container HEALTHCHECK, section 11 (a)). Problems are named, values never.
import { json } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { loadConfig } from '$lib/server/config'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = () => {
  const r = loadConfig(env)
  const colour = env.COLOUR ?? null
  if (r.ok) return json({ ok: true, colour }, { headers: { 'cache-control': 'no-store' } })
  return json({ ok: false, colour, problems: r.problems }, { status: 503, headers: { 'cache-control': 'no-store' } })
}
