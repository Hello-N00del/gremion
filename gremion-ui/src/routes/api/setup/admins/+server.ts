import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { readConfig } from '$lib/server/config'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { z } from 'zod'
import type { ApiResponse } from '$lib/api-response'
import { validateSetupToken } from '$lib/server/setup-token'
import { requireSetupRateLimit } from '$lib/server/rate-limit'

// Best-effort IP extraction; falls back to a sentinel when the test harness
// provides a partial event without `getClientAddress`.
function clientIp(event: { getClientAddress?: () => string }): string {
  try {
    return event.getClientAddress?.() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const adminsSchema = z.object({
  itAdmin: z.object({
    email: z.string().email(),
    password: z.string().min(8),
  }),
  councilAdmin: z.object({
    email: z.string().email(),
    password: z.string().min(8),
  }),
})

export const POST: RequestHandler = async (event) => {
  const { request } = event
  // T3.1: 5/hour IP-keyed limit BEFORE token validation; brute-force of the
  // bearer-style setup token is the threat we're capping here.
  const limited = requireSetupRateLimit(clientIp(event))
  if (limited) return limited
  if (!validateSetupToken(request.headers.get('X-Setup-Token'))) {
    return json({ success: false, error: 'Invalid or missing setup token' }, { status: 401 })
  }
  const config = readConfig()
  if (config.setup_complete) {
    return json({ success: false, error: 'Setup already complete' }, { status: 404 })
  }

  const body = await request.json()
  const parsed = adminsSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    )
  }

  const { itAdmin, councilAdmin } = parsed.data
  const kc = getKeycloakAdminClient(event.locals.tenant)

  // Fetch realm roles so we can assign by name
  const roles = await kc.listRealmRoles()
  const itAdminRole = roles.find((r) => r.name === 'it-admin')
  const councilAdminRole = roles.find((r) => r.name === 'council-admin')

  if (!itAdminRole || !councilAdminRole) {
    return json(
      { success: false, error: 'Required Keycloak roles not found. Ensure realm is properly configured.' },
      { status: 500 },
    )
  }

  // Create both accounts in Keycloak (passwords passed directly — never stored here)
  const [itAdminId, councilAdminId] = await Promise.all([
    kc.createUser({
      username: itAdmin.email,
      email: itAdmin.email,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: itAdmin.password, temporary: false }],
    }),
    kc.createUser({
      username: councilAdmin.email,
      email: councilAdmin.email,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: councilAdmin.password, temporary: false }],
    }),
  ])

  // Assign roles
  await Promise.all([
    kc.assignRoles(itAdminId, [itAdminRole]),
    kc.assignRoles(councilAdminId, [councilAdminRole]),
  ])

  return json({
    success: true,
    data: { created: [itAdminId, councilAdminId] },
  })
}
