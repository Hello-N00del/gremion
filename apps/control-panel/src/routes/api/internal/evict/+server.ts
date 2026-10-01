// /api/internal/evict — gremion-switch's evict fan-out reaches every
// long-running app container (gremion.evict=true). The panel caches no
// tenant, so there is nothing to evict: it verifies the INTERNAL_PUSH_SECRET
// bearer (constant time) and answers 204. No secret configured: refused.
import { timingSafeEqual } from 'node:crypto'
import { env } from '$env/dynamic/private'
import type { RequestHandler } from './$types'

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const POST: RequestHandler = ({ request }) => {
  const secret = env.INTERNAL_PUSH_SECRET
  const got = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
  if (!secret || !got || !same(got, secret)) return new Response(null, { status: 401 })
  return new Response(null, { status: 204 })
}
