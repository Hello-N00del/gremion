import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveVaultOrgUnitScope } from '$lib/server/vault/scope'
import { assertVaultItemId } from '$lib/server/vault/item-id'
import { resolveVaultBackendOr503 } from '$lib/server/vault/backend/resolve'
import { vaultStepUpEnforced, stepUpFreshnessSeconds } from '$lib/server/vault/vault-flags'
import { getActionPolicy } from '$lib/auth/actions'
import { evaluateStepUp } from '$lib/auth/step-up'

// GET /api/vault/[id]/secret — reveal one item's secret.
//
// SECURITY: the org-unit scope gate MUST fire before revealSecret() is ever
// called — an out-of-scope member gets a 403 and NEVER a secret body. The acting
// user id is forwarded to the leaf (→ x-vault-user-id) so every reveal is
// audited by WHO performed it.
//
// #405 (design v11): ciphertext delivery is additionally step-up gated — the
// server hands out a secret only to a session with a FRESH LoA 2 ("erst nach
// frischer 2FA liefert der Server Chiffretexte aus"). Enforcement mirrors the
// finance sign/reject routes (#164): evaluateStepUp BEFORE any reveal work, a
// 401 { error: 'STEP_UP_REQUIRED', requiredLoa } tells the client to run the
// /auth/step-up flow (acr_values loa2, max_age 300) and retry. The gate is ON
// by default; VAULT_REVEAL_REQUIRE_STEPUP=false disables it (vault-flags.ts).
export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  if (vaultStepUpEnforced()) {
    const policy = getActionPolicy('vault.secret.reveal')
    const decision = evaluateStepUp(
      { loa: user.loa, authTime: user.authTime },
      policy.requiredLoa,
      { nowMs: Date.now(), freshnessSeconds: stepUpFreshnessSeconds() },
    )
    if (!decision.ok) {
      return json({ error: 'STEP_UP_REQUIRED', requiredLoa: decision.requiredLoa }, { status: 401 })
    }
  }
  const resolved = resolveVaultBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  // #449: same malformed-id guard as the sibling [id] routes.
  assertVaultItemId(params.id)
  const item = await backend.getItem(params.id)
  if (!item) throw error(404, 'Eintrag nicht gefunden')
  const ouIds = await resolveVaultOrgUnitScope({ userId: user.id, roles: user.roles })
  if (!ouIds.includes(item.org_unit_id)) throw error(403, 'Kein Zugriff auf diesen Eintrag')
  const revealed = await backend.revealSecret(params.id, user.id)
  return json({ data: revealed })
}
