import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getActionPolicy } from '$lib/auth/actions'
import { evaluateStepUp } from '$lib/auth/step-up'
import { deriveAbbr, deriveHue } from '$lib/governance/committee-color'
import { formatVaultDate, formatVaultLogTs } from '$lib/vault/vault-view'
import { resolveVaultOrgUnitScope } from '$lib/server/vault/scope'
import { resolveVaultBackendForPage } from '$lib/server/vault/backend/resolve'
import { vaultStepUpEnforced, stepUpFreshnessSeconds } from '$lib/server/vault/vault-flags'
import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { getDisplayNameResolver } from '$lib/server/identity/display-names'
import { handoverTracksReferencingVaultItems } from '$lib/server/handover/handover-vault-links'
import { readConfig } from '$lib/server/config'

// The Zugriffsprotokoll side card ships one page-load slice: newest 8 rendered,
// "Mehr anzeigen" walks the rest of this window client-side (a deeper history
// stays on GET /api/vault/access-log).
const LOG_WINDOW = 32

// /vault (#405 design v11, prototype web/vault.jsx VaultScreen) — the native
// Tresor page load. Ships everything the surface needs in ONE pass:
//   - the org-unit compartments in the member's scope (hue/abbr like the
//     committee tree — same deriveHue/deriveAbbr, so a Referat keeps its colour
//     across surfaces);
//   - the vault items (metadata ONLY — secrets are revealed one at a time via
//     GET /api/vault/[id]/secret, which re-checks scope + step-up and audits);
//   - the handover cross-links (which non-archived Übergabe-Tracks reference
//     each item → the "Übergabe · <Track>" chip);
//   - the newest access-log slice (Zugriffsprotokoll card);
//   - the HONEST lock inputs: stepUpEnforced + stepUpOk mirror the reveal
//     route's own gate (finance approvals #164 pattern), so the page locks
//     exactly when the server would 401 STEP_UP_REQUIRED.
// Raw Keycloak UUIDs (created_by, accessed_by) are resolved to display names
// server-side (WI-4A rule: members never see a UUID) and dates are formatted
// here so the client renders plain strings.
export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const isIT = hasRole(user.roles, Role.ITAdmin)

  const backend = resolveVaultBackendForPage()
  const ouIds = await resolveVaultOrgUnitScope({ userId: user.id, roles: user.roles })
  const [items, log, allUnits] = await Promise.all([
    backend.listItemsForOrgUnits(ouIds),
    backend.listAccessLog(ouIds, { limit: LOG_WINDOW, offset: 0 }),
    listOrgUnits(),
  ])

  // One Fach per in-scope unit — including empty ones (the page hides only
  // empty council compartments, vault-view.visibleUnits).
  const inScope = new Set(ouIds)
  const units = allUnits
    .filter((o) => inScope.has(o.id))
    .map((o) => ({ id: o.id, name: o.name, kind: o.kind, hue: deriveHue(o.id), abbr: deriveAbbr(o.name) }))

  // Handover cross-links: only when the handover module is ON for this tenant —
  // a module-off tenant must get no /handover chip (dead link) and no query
  // against possibly-skipped handover tables. Degrades to no chips on any error
  // (the vault page must not break because the cross-link source is down).
  let handoverEnabled = true
  try {
    handoverEnabled = readConfig().modules['handover'] !== false
  } catch {
    handoverEnabled = true
  }
  const refs = handoverEnabled
    ? await handoverTracksReferencingVaultItems(items.map((i) => i.id)).catch(
        () => new Map<string, string[]>(),
      )
    : new Map<string, string[]>()

  // Resolve every referenced Keycloak UUID → display name in one batch.
  const ids = new Set<string>()
  for (const i of items) if (i.created_by) ids.add(i.created_by)
  for (const l of log) ids.add(l.accessed_by)
  const names = await getDisplayNameResolver().resolveMany([...ids])

  return {
    units,
    items: items.map((i) => ({
      id: i.id,
      org_unit_id: i.org_unit_id,
      name: i.name,
      username: i.username,
      url: i.url,
      created: formatVaultDate(new Date(i.created_at)),
      createdByName: i.created_by ? (names.get(i.created_by) ?? i.created_by) : null,
    })),
    // Map → plain object so SvelteKit serializes it.
    handoverRefs: Object.fromEntries(refs),
    log: log.map((l) => ({
      id: l.id,
      ts: formatVaultLogTs(new Date(l.accessed_at)),
      actor: names.get(l.accessed_by) ?? l.accessed_by,
      itemName: l.item_name,
    })),
    isIT,
    // #405 lock inputs — mirror of the reveal route's gate (finance #164 pattern).
    stepUpEnforced: vaultStepUpEnforced(),
    stepUpOk: vaultStepUpEnforced()
      ? evaluateStepUp(
          { loa: user.loa, authTime: user.authTime },
          getActionPolicy('vault.secret.reveal').requiredLoa,
          { nowMs: Date.now(), freshnessSeconds: stepUpFreshnessSeconds() },
        ).ok
      : true,
  }
}
