import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

// Stub: replaced by the real handler once the tests are in place.
export const GET: RequestHandler = async () =>
  json({ success: true, data: { minutes: [], events: [], units: [], people: [] } })
