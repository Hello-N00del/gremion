import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { readConfig, writeConfig, configUpdateSchema } from '$lib/server/config'
import type { ApiResponse } from '$lib/api-response'
import { validateSetupToken, clearSetupToken } from '$lib/server/setup-token'
import { requireSetupRateLimit } from '$lib/server/rate-limit'

// Best-effort IP extraction. SvelteKit's RequestEvent exposes
// `getClientAddress()` in production; tests sometimes pass partial events
// where it's missing, so we fall back to a stable sentinel rather than
// crashing the request.
function clientIp(event: { getClientAddress?: () => string }): string {
  try {
    return event.getClientAddress?.() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// GET — returns current config; guarded by setup token
// Returns 404 if setup is already complete (wizard locked)
export const GET: RequestHandler = async (event) => {
  const { request } = event
  // T3.1: rate-limit BEFORE token validation so wrong-token attempts still count.
  const limited = requireSetupRateLimit(clientIp(event))
  if (limited) return limited
  if (!validateSetupToken(request.headers.get('X-Setup-Token'))) {
    return json({ success: false, error: 'Invalid or missing setup token' }, { status: 401 })
  }
  const config = readConfig()
  if (config.setup_complete) {
    return json({ success: false, error: 'Setup already complete' }, { status: 404 })
  }
  // Strip wizard_steps — implementation detail not needed by client
  const { wizard_steps: _, ...rest } = config
  return json({ success: true, data: rest })
}

// PATCH — accepts partial config update; merges into current config
export const PATCH: RequestHandler = async (event) => {
  const { request } = event
  const limited = requireSetupRateLimit(clientIp(event))
  if (limited) return limited
  if (!validateSetupToken(request.headers.get('X-Setup-Token'))) {
    return json({ success: false, error: 'Invalid or missing setup token' }, { status: 401 })
  }
  const config = readConfig()
  if (config.setup_complete) {
    return json({ success: false, error: 'Setup already complete' }, { status: 404 })
  }
  // G-074: strict-validate the incoming body before passing to writeConfig.
  // Unknown top-level keys (typos, drift from setup-wizard codebase, or
  // hand-crafted requests) are rejected with a 422 instead of silently
  // merged. writeConfig itself also re-validates as a defensive belt — both
  // gates exist on purpose so internal callers can't bypass either.
  const body = (await request.json()) as unknown
  const parsed = configUpdateSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || '<root>'
    return json(
      { success: false, error: `Invalid config update: ${path} — ${issue?.message ?? 'invalid'}` },
      { status: 422 },
    )
  }
  const updated = writeConfig(parsed.data)
  // Token is no longer needed once setup is marked complete
  if (updated.setup_complete) clearSetupToken()
  return json({ success: true, data: updated })
}
