import { redirect } from '@sveltejs/kit'
import type { LayoutServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { generateLoeschkonzept } from '$lib/server/loeschkonzept'
import { buildProcessingActivities, generateVerarbeitungsverzeichnis } from '$lib/server/verarbeitungsverzeichnis'
import { getDataProvider } from '$lib/server/modules/runtime-registry'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import type { TenantContext } from '$lib/server/tenant/context'

// Keycloak account console for the "Profil in Keycloak" handoff. Derived from
// the REQUEST tenant's Auth.js external base ({base}/realms/<realm> →
// {…}/account; TASK-042: per tenant, never a deployment-global env), surfaced
// as a ready-made absolute URL (or null when there is no resolved tenant).
function keycloakAccountUrl(tenant: Pick<TenantContext, 'authExternalBase'> | null | undefined): string | null {
  const base = (tenant?.authExternalBase ?? '').replace(/\/$/, '')
  return base ? `${base}/account` : null
}

export const load: LayoutServerLoad = async ({ locals, fetch }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined

  if (!user || !hasRole(user.roles, Role.Member)) {
    redirect(302, '/auth/login')
  }

  const isITAdmin = hasRole(user.roles, Role.ITAdmin)
  const isAdmin = hasRole(user.roles, Role.CouncilAdmin)

  let config = null
  if (isITAdmin) {
    const res = await fetch('/api/settings')
    if (res.ok) {
      const body = await res.json()
      config = body.data
    }
  }

  // #164: truthful, flag-gated 2FA enrollment chip.
  // When the flag is OFF we skip the KC call entirely — no latency, no lie.
  // When ON, a 2-second timeout + catch ensures a slow/failed KC call never
  // breaks the settings page; mfaEnrolled=null → chip hidden (neutral).
  // A3c S1: the step-up master switch is a finance data provider on the runtime-
  // registry — the kernel settings layout no longer imports finance internals. An
  // absent finance module (provider unregistered) reads as `false`, exactly as the
  // OFF flag did (chip skipped, no KC call).
  const stepUpEnforced = getDataProvider('finance:step-up-enforced')?.() ?? false
  let mfaEnrolled: boolean | null = null
  if (stepUpEnforced) {
    try {
      mfaEnrolled = await Promise.race([
        getKeycloakAdminClient(locals.tenant).hasOtpCredential(user.id),
        new Promise<boolean>((_, rej) =>
          setTimeout(() => rej(new Error('kc-timeout')), 2000),
        ),
      ])
    } catch {
      mfaEnrolled = null // neutral chip; never break settings load
    }
  }

  return {
    config,
    isAdmin,
    isITAdmin,
    // #167: the Datenschutz section panel renders the generated Löschkonzept
    // preview that previously lived in the standalone compliance/+page.server.ts.
    // Only it-admins have `config`, and only they ever see this section, so the
    // preview is generated only for them (members get null).
    loeschkonzept: isITAdmin && config ? generateLoeschkonzept(config) : null,
    // TRD-162: record of processing activities, same it-admin-only rule.
    verarbeitungsverzeichnis:
      isITAdmin && config
        ? { document: generateVerarbeitungsverzeichnis(config), activities: buildProcessingActivities(config) }
        : null,
    // Minimal user projection for the settings profile card (no tokens).
    user: { name: user.name, email: user.email, groups: user.groups },
    accountUrl: keycloakAccountUrl(locals.tenant),
    // #164: 2FA enrollment state (null = lookup skipped or failed → chip hidden).
    mfaEnrolled,
    stepUpEnforced,
  }
}
