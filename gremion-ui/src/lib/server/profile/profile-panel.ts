// Server side of Settings > Profil: what the page loads (current names and e-mail
// from Keycloak, whether the e-mail action is offered, the outcome of a returned
// account action) and the production wiring of the two form actions.
import type { SessionUser } from '$lib/auth/types'
import { getKeycloakAdminClient, type KcUser } from '$lib/server/keycloak-admin'
import type { TenantContext } from '$lib/server/tenant/context'
import {
  createCapabilityCache,
  readAccountActionResult,
  type AccountActionResult,
  type StartAccountActionDeps,
} from './account-actions'
import type { OwnNameDeps } from './own-name'

export interface ProfilePanelData {
  /** The stored names and address of the signed-in user; null = not readable (the form is hidden). */
  profile: { firstName: string; lastName: string; email: string } | null
  /** Server-side capability: UPDATE_EMAIL is enabled in this realm. Hidden by default. */
  emailActionAvailable: boolean
  /** Outcome of an account action the user just came back from, once. */
  accountActionResult: AccountActionResult | null
}

export interface ProfilePanelDeps {
  getUser(id: string): Promise<Pick<KcUser, 'firstName' | 'lastName' | 'email'>>
  emailActionAvailable(): Promise<boolean>
}

const READ_BUDGET_MS = 2000

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export async function loadProfilePanel(
  args: { user: Pick<SessionUser, 'id'>; cookies: Parameters<typeof readAccountActionResult>[0]; wantsProfile: boolean },
  deps: ProfilePanelDeps,
): Promise<ProfilePanelData> {
  if (!args.wantsProfile) return { profile: null, emailActionAvailable: false, accountActionResult: null }
  const accountActionResult = readAccountActionResult(args.cookies)
  const [profile, emailActionAvailable] = await Promise.all([
    withTimeout(deps.getUser(args.user.id), READ_BUDGET_MS).then(
      (u) => ({ firstName: u.firstName ?? '', lastName: u.lastName ?? '', email: u.email ?? '' }),
      (err: unknown) => {
        console.warn('[profile] user read failed', { error: err instanceof Error ? err.name : typeof err })
        return null
      },
    ),
    withTimeout(deps.emailActionAvailable(), READ_BUDGET_MS).catch(() => false),
  ])
  return { profile, emailActionAvailable, accountActionResult }
}

// ---- production wiring --------------------------------------------------------------

const emailCapability = createCapabilityCache()

/** UPDATE_EMAIL availability of one tenant's realm, cached per tenant id for a minute. */
function emailActionAvailableFor(tenant: TenantContext): () => Promise<boolean> {
  return () => emailCapability.get(tenant.id, () => getKeycloakAdminClient(tenant).isRequiredActionEnabled('UPDATE_EMAIL'))
}

export function profilePanelDeps(tenant: TenantContext): ProfilePanelDeps {
  return {
    getUser: (id) => getKeycloakAdminClient(tenant).getUser(id),
    emailActionAvailable: emailActionAvailableFor(tenant),
  }
}

export function ownNameDeps(tenant: TenantContext): OwnNameDeps {
  return { updateUserNames: (id, names) => getKeycloakAdminClient(tenant).updateUserNames(id, names) }
}

export function accountActionDeps(tenant: TenantContext, signIn: StartAccountActionDeps['signIn']): StartAccountActionDeps {
  return {
    signIn,
    hasOtpCredential: (id) => withTimeout(getKeycloakAdminClient(tenant).hasOtpCredential(id), 5000),
    emailActionAvailable: emailActionAvailableFor(tenant),
  }
}
