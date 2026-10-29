// src/lib/server/tenant/provisioner/kc-admin-api.ts
// P2.1c (T10) — the Keycloak Admin-API sequence the provisioner runs against a
// realm. Ports scripts/configure-keycloak-clients.sh:188-252 (the
// `configure_stepup_flow` #164 step-up sequence) 1:1 into TS, plus the realm
// create POST and a realm-exists probe. Subprocess-free fetch (D-PROVSCRIPT).
//
// Idempotent (§4-2 / [[keycloak-import-realm-skips-existing-apply-via-admin-api]]):
// the (non-atomic) flow build is guarded behind flow existence; the realm-config
// and acr-mapper steps no-op on re-run. ORDER MATTERS — the flow must exist
// BEFORE realm.browserFlow can point at it (else PUT /realms 500s).
//
// The HTTP transport is INJECTED (KcTransport) so the sequence is fully
// unit-testable with a scripted fake KC; the live wiring (token fetch + fetch)
// lives in the CLI.

/** A method+path+body transport against KC. `path` is the full admin path
 *  starting with `/admin/realms/...`. Throws on a non-OK HTTP response (the
 *  error message MUST include the status code so callers can distinguish
 *  404/409). Returns the parsed JSON body, or undefined for 204. */
export type KcTransport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** (C/FIX3-B) Encode a realm name for use as a single Admin-API path segment.
 *  Shared so EVERY realm-scoped path in the provisioner — including reconcile.ts's
 *  GET/PUT helpers — goes through the same encoding, and a realm name can never
 *  break out of its segment (no `../`, no query-string injection, no spaces) even
 *  if a future caller forgets the upstream validateSlug. Exported because
 *  reconcile.ts builds its own thin transport wrapper rather than going through
 *  KcProvisionApi.realmGet/realmReq. */
export function realmSeg(realm: string): string {
  return encodeURIComponent(realm)
}

function statusFrom(err: unknown): number | null {
  const m = /\b(\d{3})\b/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : null
}

/** The Keycloak Admin API status a transport error carries (the CLI transport's
 *  `Keycloak Admin API error: <status> on ...`), else null. */
export function adminApiStatus(err: unknown): number | null {
  const m = /Keycloak Admin API error: (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : null
}

/**
 * #48: the master `<realm>-realm` client roles Keycloak grants the account that
 * CREATES a realm. Keycloak 26.6.1 `RealmsAdminResource.grantPermissionsToRealmCreator`
 * grants `AdminRoles.ALL_REALM_ROLES` on `realm.getMasterAdminClient()` (the master
 * client `<realm>` + `AdminRoles.APP_SUFFIX` "-realm"), unless the caller already
 * holds master `admin`. The management client also carries `impersonation` and
 * `view-system`; a creator gets neither, and neither do we. Re-check this list
 * against `AdminRoles.ALL_REALM_ROLES` when the Keycloak pin moves.
 */
export const REALM_CREATOR_ROLES: readonly string[] = [
  'create-client',
  'view-realm',
  'view-users',
  'view-clients',
  'view-events',
  'view-identity-providers',
  'view-authorization',
  'manage-realm',
  'manage-users',
  'manage-clients',
  'manage-events',
  'manage-identity-providers',
  'manage-authorization',
  'query-users',
  'query-clients',
  'query-realms',
  'query-groups',
]

/** The master client that holds a realm's admin roles (Keycloak's master admin client for it). */
export const masterAdminClientId = (realm: string): string => `${realm}-realm`

/** A realm name `--adopt-realm` accepts: what tenant realms are named (lowercase, digits, `-`, `_`). */
const ADOPTABLE_REALM_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** The user attribute that records a first administrator's invite (send-once). */
export const INVITE_MARK = 'gremion_invited_at'

/** Security sweep 2 (finding 3). stepup-2fa must NOT hold a REQUIRED OTP form:
 *  for a user with no OTP credential Keycloak then runs CONFIGURE_TOTP inside the
 *  step-up and issues acr=loa2 once the user has enrolled, so whoever holds the
 *  session (or the password) enrolls their own authenticator and passes the
 *  "fresh 2FA" gate. The OTP form instead sits in this REQUIRED subflow as an
 *  ALTERNATIVE, followed by deny-access as the other ALTERNATIVE: a user with an
 *  OTP credential gets the OTP prompt; a user without one is denied (the OTP
 *  alternative is skipped, no enrolment is offered). */
export const STEPUP_2FA_SECOND_FACTOR = 'stepup-2fa second factor'

/** One row of the Admin API's flattened `/authentication/flows/<alias>/executions`. */
export interface FlowExecRep {
  id?: string
  providerId?: string
  displayName?: string
  requirement?: string
  level?: number
  index?: number
  authenticationFlow?: boolean
  authenticationConfig?: string
}

const isSecondFactorSubflow = (e: FlowExecRep): boolean =>
  e.authenticationFlow === true && e.displayName === STEPUP_2FA_SECOND_FACTOR

/** null when the flattened stepup-2fa execution list has the hardened shape,
 *  else why not. Pure: reconcile's check and the repair share it. */
export function stepup2faGateProblem(execs: readonly FlowExecRep[]): string | null {
  const otps = execs.filter((e) => e.providerId === 'auth-otp-form')
  if (otps.length !== 1) return `stepup-2fa carries ${otps.length} OTP forms (expected exactly 1)`
  const otp = otps[0]!
  const sub = execs.find(isSecondFactorSubflow)
  if (!sub) return `the OTP form is not under the "${STEPUP_2FA_SECOND_FACTOR}" subflow (a REQUIRED OTP form enrolls a missing authenticator and then grants loa2)`
  if (sub.requirement !== 'REQUIRED') return `the "${STEPUP_2FA_SECOND_FACTOR}" subflow is ${sub.requirement}, expected REQUIRED`
  if (otp.requirement !== 'ALTERNATIVE') return `the OTP form is ${otp.requirement}, expected ALTERNATIVE (REQUIRED would enroll a missing authenticator and then grant loa2)`
  const deny = execs.find((e) => e.providerId === 'deny-access-authenticator')
  if (!deny) return 'no deny-access sibling: a user without OTP would not be refused'
  if (deny.requirement !== 'ALTERNATIVE') return `deny-access is ${deny.requirement}, expected ALTERNATIVE`
  if (deny.level !== otp.level || (otp.level ?? 0) < 1) return 'the OTP form and deny-access are not siblings inside the subflow'
  if ((otp.index ?? 0) > (deny.index ?? 0)) return 'deny-access is ordered before the OTP form (a user with OTP would always be denied)'
  // The subflow's rows are the ones after it in the flattened list, deeper than
  // it. It must hold exactly [OTP, deny-access] (a DISABLED row is inert): any
  // other enabled row (an allow-access ALTERNATIVE, a nested flow) can let a user
  // without OTP through, and OTP/deny must be ITS direct children, not another
  // subflow's.
  const subLevel = sub.level ?? 0
  const members: FlowExecRep[] = []
  for (let i = execs.indexOf(sub) + 1; i < execs.length && (execs[i]!.level ?? 0) > subLevel; i++) members.push(execs[i]!)
  if (!members.includes(otp) || !members.includes(deny) || otp.level !== subLevel + 1) {
    return `the OTP form and deny-access are not the direct children of the "${STEPUP_2FA_SECOND_FACTOR}" subflow`
  }
  const extra = members.filter((e) => e !== otp && e !== deny && e.requirement !== 'DISABLED')
  if (extra.length > 0) {
    return `the "${STEPUP_2FA_SECOND_FACTOR}" subflow holds ${extra.map((e) => e.providerId ?? e.displayName ?? '?').join(', ')} besides the OTP form and deny-access (a user without OTP could pass)`
  }
  return null
}

export class KcProvisionApi {
  constructor(private readonly transport: KcTransport) {}

  /** (C) Defence-in-depth: encode the realm segment before it lands in a path.
   *  The CLI already validateSlug's the realm, but encoding here means a realm
   *  name can never break out of its path segment even if a future caller
   *  forgets the guard (no `../`, no query-string injection, no spaces).
   *  Delegates to the shared module-level `realmSeg` so reconcile.ts and this
   *  class encode realm segments identically (FIX3-B). */
  private static realmSeg(realm: string): string {
    return realmSeg(realm)
  }

  /** GET against a realm-scoped path (path relative to /admin/realms/<realm>). */
  private realmGet<T = unknown>(realm: string, path: string): Promise<T> {
    return this.transport('GET', `/admin/realms/${KcProvisionApi.realmSeg(realm)}${path}`) as Promise<T>
  }
  private realmReq(realm: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return this.transport(method, `/admin/realms/${KcProvisionApi.realmSeg(realm)}${path}`, body)
  }

  /** POST a full realm representation. A 409 (already exists) is reported as
   *  `{ alreadyExisted: true }` (provision -> reconcile path), not an error. */
  async createRealm(realmDoc: Record<string, unknown>): Promise<{ alreadyExisted: boolean }> {
    try {
      await this.transport('POST', '/admin/realms', realmDoc)
      return { alreadyExisted: false }
    } catch (err) {
      if (statusFrom(err) === 409) return { alreadyExisted: true }
      throw err
    }
  }

  /** gremion#6 (spec B §T.4) — apply the SMTP settings to an ALREADY-CREATED
   *  realm as an Admin-API DELTA. Spec A §H: changes to an existing realm are
   *  Admin-API deltas, never a re-import. KC merges a partial realm rep, so the
   *  body carries only the realm name and the smtpServer block. */
  async updateRealmSmtp(realm: string, smtpServer: Record<string, string>): Promise<void> {
    await this.transport('PUT', `/admin/realms/${KcProvisionApi.realmSeg(realm)}`, {
      realm,
      smtpServer,
    })
  }

  /** T17 (§8.7) — DELETE /admin/realms/<realm>. Idempotent: a 404 (realm already
   *  gone — e.g. a re-run after a partial delete) is a no-op, not an error. */
  async deleteRealm(realm: string): Promise<void> {
    try {
      await this.transport('DELETE', `/admin/realms/${KcProvisionApi.realmSeg(realm)}`)
    } catch (err) {
      if (statusFrom(err) === 404) return
      throw err
    }
  }

  /** True iff the realm exists (GET /admin/realms/<realm> succeeds).
   *
   *  A 404 OR a 403 is treated as "absent": the §7.2 least-privilege
   *  `tenant-provisioner` SA holds ONLY `create-realm`, and Keycloak returns
   *  403 (not 404) when that SA GETs a realm it has no realm-management role on
   *  — which, for a fresh tenant, is the realm being provisioned. Mapping 403→
   *  absent lets provisioning proceed to createRealm; if the realm DID already
   *  exist, createRealm's 409 path is the authoritative idempotent backstop, so
   *  this never clobbers an existing realm. (Surfaced provisioning the first
   *  real SA-based tenant `musterstadt`, P2.3 #202.) */
  async realmExists(realm: string): Promise<boolean> {
    try {
      await this.transport('GET', `/admin/realms/${KcProvisionApi.realmSeg(realm)}`)
      return true
    } catch (err) {
      const s = statusFrom(err)
      if (s === 404 || s === 403) return false
      throw err
    }
  }

  /**
   * (A) #164/governance-sync: grant `realm-management` client roles to a client's
   * service-account user. Ports `assign_realm_admin_to_sa`
   * (configure-keycloak-clients.sh:102-147) 1:1: KC 26's realm import does NOT
   * carry service-account role mappings reliably, so a provisioned realm's
   * gremion-admin SA can do `client_credentials` but every Admin REST op
   * (manage-users/manage-groups/view-realm) 403s — breaking governance sync,
   * newsletter group resolution, and #164 step-up freshness. This MUST run
   * post-create against the realm to give the SA admin access.
   *
   * Idempotent (KC silently no-ops duplicate role-mappings): client UUID ->
   * service-account-user -> realm-management client UUID -> the named role reps ->
   * POST /role-mappings/clients/<rm-uuid>. A missing service-account-user (the
   * client lacks `serviceAccountsEnabled`) or a missing realm-management client is
   * a contract violation and throws loudly.
   */
  async assignServiceAccountRealmRoles(realm: string, clientId: string, roleNames: readonly string[]): Promise<void> {
    // 1. The client UUID behind the clientId.
    const clients = await this.realmGet<Array<{ id?: string }>>(
      realm,
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    )
    const clientUuid = clients[0]?.id
    if (!clientUuid) throw new Error(`assignServiceAccountRealmRoles: client "${clientId}" not found in realm "${realm}"`)

    // 2. The service-account user behind that client.
    const saUser = await this.realmGet<{ id?: string }>(realm, `/clients/${clientUuid}/service-account-user`)
    const saUserId = saUser?.id
    if (!saUserId) {
      throw new Error(
        `assignServiceAccountRealmRoles: no service-account user for client "${clientId}" (is serviceAccountsEnabled set?) in realm "${realm}"`,
      )
    }

    // 3. The realm-management client UUID.
    const rmClients = await this.realmGet<Array<{ id?: string }>>(realm, '/clients?clientId=realm-management')
    const rmUuid = rmClients[0]?.id
    if (!rmUuid) throw new Error(`assignServiceAccountRealmRoles: realm-management client not found in realm "${realm}"`)

    // 4. Resolve each named realm-management role rep.
    const roleReps: Array<Record<string, unknown>> = []
    for (const name of roleNames) {
      const role = await this.realmGet<Record<string, unknown>>(
        realm,
        `/clients/${rmUuid}/roles/${encodeURIComponent(name)}`,
      )
      roleReps.push(role)
    }
    if (roleReps.length === 0) return // nothing to assign

    // 5. POST the role-mappings (idempotent — KC no-ops duplicates).
    await this.realmReq(realm, 'POST', `/users/${saUserId}/role-mappings/clients/${rmUuid}`, roleReps)
  }

  /**
   * (A) Read the realm-management client-role names currently mapped to a client's
   * service-account user — the reconcile-side reader for `gremion-admin-sa-roles`.
   * Returns the empty array when the client/SA-user/realm-management client is
   * absent (the check fails loudly upstream when the expected roles are missing).
   */
  async getServiceAccountRealmRoleNames(realm: string, clientId: string): Promise<string[]> {
    const clients = await this.realmGet<Array<{ id?: string }>>(
      realm,
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    )
    const clientUuid = clients[0]?.id
    if (!clientUuid) return []
    const saUser = await this.realmGet<{ id?: string }>(realm, `/clients/${clientUuid}/service-account-user`)
    const saUserId = saUser?.id
    if (!saUserId) return []
    const rmClients = await this.realmGet<Array<{ id?: string }>>(realm, '/clients?clientId=realm-management')
    const rmUuid = rmClients[0]?.id
    if (!rmUuid) return []
    const mapped = await this.realmGet<Array<{ name?: string }>>(
      realm,
      `/users/${saUserId}/role-mappings/clients/${rmUuid}`,
    )
    return (mapped ?? []).map((r) => r.name).filter((n): n is string => typeof n === 'string')
  }

  /**
   * §7.2 bootstrap — mint the least-privilege provisioner service account: a
   * confidential `client_credentials` client whose service-account user holds ONLY
   * the named REALM-LEVEL role(s) (e.g. `create-realm` in the master realm; KC then
   * grants the creator per-realm admin on realms it creates) — NEVER the admin
   * superuser, NEVER a tenant data-plane credential. Idempotent: a 409 on create
   * reuses the existing client (KC also no-ops a duplicate role-mapping). Returns
   * the client secret (for the operator's provisioner secret file) and whether the
   * client was freshly created. Used once by `bootstrap-provisioner`.
   */
  async createProvisionerServiceAccount(
    realm: string,
    clientId: string,
    realmRoleNames: readonly string[],
  ): Promise<{ clientSecret: string; created: boolean }> {
    // 1. Create the confidential SA client (idempotent: 409 => reuse).
    let created = false
    try {
      await this.transport('POST', `/admin/realms/${KcProvisionApi.realmSeg(realm)}/clients`, {
        clientId,
        protocol: 'openid-connect',
        enabled: true,
        publicClient: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        implicitFlowEnabled: false,
      })
      created = true
    } catch (err) {
      if (statusFrom(err) !== 409) throw err
    }

    // 2. Resolve the client UUID behind the clientId.
    const clients = await this.realmGet<Array<{ id?: string }>>(
      realm,
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    )
    const clientUuid = clients[0]?.id
    if (!clientUuid) {
      throw new Error(`createProvisionerServiceAccount: client "${clientId}" not found after create in realm "${realm}"`)
    }

    // 3. Assign the named REALM-LEVEL roles to the service-account user. NOTE: these
    //    are top-level realm roles (e.g. master's `create-realm`), NOT
    //    realm-management client roles — so the mapping target is /role-mappings/realm,
    //    distinct from assignServiceAccountRealmRoles' /role-mappings/clients/<rm>.
    const saUser = await this.realmGet<{ id?: string }>(realm, `/clients/${clientUuid}/service-account-user`)
    const saUserId = saUser?.id
    if (!saUserId) {
      throw new Error(
        `createProvisionerServiceAccount: no service-account user for "${clientId}" (is serviceAccountsEnabled set?) in realm "${realm}"`,
      )
    }
    const roleReps: Array<Record<string, unknown>> = []
    for (const name of realmRoleNames) {
      roleReps.push(await this.realmGet<Record<string, unknown>>(realm, `/roles/${encodeURIComponent(name)}`))
    }
    if (roleReps.length > 0) {
      await this.realmReq(realm, 'POST', `/users/${saUserId}/role-mappings/realm`, roleReps)
    }

    // 4. Read back the generated client secret.
    const secret = await this.realmGet<{ value?: string }>(realm, `/clients/${clientUuid}/client-secret`)
    if (!secret?.value) {
      throw new Error(`createProvisionerServiceAccount: no client secret returned for "${clientId}" in realm "${realm}"`)
    }
    return { clientSecret: secret.value, created }
  }

  /**
   * #48 `bootstrap-provisioner --adopt-realm <realm>`: give the provisioner SA the
   * rights Keycloak would have given it had it created `realm` (an imported realm,
   * or one that predates the SA, answers it 403 otherwise). Runs once, as the
   * Keycloak admin (like the SA seed), entirely in the master realm: the SA user's
   * client-role mapping on master `<realm>-realm`, exactly REALM_CREATOR_ROLES.
   * Idempotent: the roles already held are read first and only the missing ones
   * are posted, so a rerun writes nothing. Refuses `master` (its management
   * client would be the whole Keycloak) and any name that is not a realm name.
   */
  async adoptRealmForProvisioner(saClientId: string, realm: string): Promise<{ granted: string[]; alreadyHeld: string[] }> {
    if (!ADOPTABLE_REALM_RE.test(realm)) throw new Error(`adopt-realm: ${JSON.stringify(realm)} is not a realm name (${ADOPTABLE_REALM_RE.source})`)
    if (realm === 'master') throw new Error('adopt-realm: refusing the master realm (its master-realm client is admin over all of Keycloak)')
    const exact = async (clientId: string): Promise<string | undefined> => {
      const hits = (await this.realmGet<Array<{ id?: string; clientId?: string }>>('master', `/clients?clientId=${encodeURIComponent(clientId)}`)) ?? []
      return hits.find((c) => c.clientId === clientId)?.id
    }
    const saUuid = await exact(saClientId)
    if (!saUuid) throw new Error(`adopt-realm: master has no client "${saClientId}": run bootstrap-provisioner first`)
    const saUser = await this.realmGet<{ id?: string }>('master', `/clients/${saUuid}/service-account-user`)
    if (!saUser?.id) throw new Error(`adopt-realm: client "${saClientId}" has no service-account user (is serviceAccountsEnabled set?)`)
    const mgmtId = masterAdminClientId(realm)
    const mgmtUuid = await exact(mgmtId)
    if (!mgmtUuid) throw new Error(`adopt-realm: master has no client "${mgmtId}": no realm "${realm}" on this Keycloak`)
    const mappingPath = `/users/${saUser.id}/role-mappings/clients/${mgmtUuid}`
    const held = new Set(((await this.realmGet<Array<{ name?: string }>>('master', mappingPath)) ?? []).map((r) => r.name))
    const alreadyHeld = REALM_CREATOR_ROLES.filter((r) => held.has(r))
    const granted = REALM_CREATOR_ROLES.filter((r) => !held.has(r))
    if (granted.length === 0) return { granted, alreadyHeld }
    const reps: Array<Record<string, unknown>> = []
    for (const name of granted) {
      const rep = await this.realmGet<Record<string, unknown> | undefined>('master', `/clients/${mgmtUuid}/roles/${encodeURIComponent(name)}`)
      if (rep?.name !== name) throw new Error(`adopt-realm: client "${mgmtId}" has no role "${name}": refusing a partial grant`)
      reps.push(rep)
    }
    await this.realmReq('master', 'POST', mappingPath, reps)
    // the post-condition, read back: every creator role is now mapped
    const after = new Set(((await this.realmGet<Array<{ name?: string }>>('master', mappingPath)) ?? []).map((r) => r.name))
    const missing = REALM_CREATOR_ROLES.filter((r) => !after.has(r))
    if (missing.length) throw new Error(`adopt-realm: after the grant, master client "${mgmtId}" still lacks [${missing.join(', ')}] for "${saClientId}"`)
    return { granted, alreadyHeld }
  }

  private setReq(realm: string, execId: string, requirement: string): Promise<unknown> {
    return this.realmReq(realm, 'PUT', '/authentication/flows/browser-stepup/executions', {
      id: execId,
      requirement,
    })
  }
  private setCfg(realm: string, execId: string, alias: string, level: string, maxAge: string): Promise<unknown> {
    return this.realmReq(realm, 'POST', `/authentication/executions/${execId}/config`, {
      alias,
      config: { 'loa-condition-level': level, 'loa-max-age': maxAge },
    })
  }

  /**
   * (C) Repair the Condition-LoA config (level + maxAge) on an EXISTING
   * browser-stepup flow. configureStepupFlow writes the LoA configs only when it
   * CREATES the flow, so a drifted maxAge/level on a long-lived flow was never
   * mechanically repaired (reconcile reported `stepup-loa-config` as applied but
   * did NOT actually fix it). This finds each subflow's conditional execution and
   * writes its config to contract — PUT-ing an existing config in place, or
   * POST-ing a fresh one if the execution carries none yet. Idempotent. A missing
   * subflow/conditional execution is a structural drift (the flow itself is broken)
   * and is left to the step-up rebuild path — this method only no-ops on it.
   */
  async repairStepupLoaConfig(realm: string): Promise<void> {
    const repairs: Array<{ subflow: string; alias: string; level: string; maxAge: string }> = [
      { subflow: 'stepup-1fa', alias: 'stepup-loa1', level: '1', maxAge: '36000' },
      { subflow: 'stepup-2fa', alias: 'stepup-loa2', level: '2', maxAge: '300' },
    ]
    for (const r of repairs) {
      const execs = await this.realmGet<Array<{ id?: string; providerId?: string; authenticationConfig?: string }>>(
        realm,
        `/authentication/flows/${encodeURIComponent(r.subflow)}/executions`,
      )
      const cond = (execs ?? []).find((e) => e.providerId === 'conditional-level-of-authentication')
      if (!cond?.id) continue // structural drift — the step-up rebuild owns it
      const config = { 'loa-condition-level': r.level, 'loa-max-age': r.maxAge }
      if (cond.authenticationConfig) {
        // Update the existing config in place (PUT /authentication/config/<id>).
        await this.realmReq(realm, 'PUT', `/authentication/config/${cond.authenticationConfig}`, {
          alias: r.alias,
          config,
        })
      } else {
        // No config yet — create one bound to the execution.
        await this.setCfg(realm, cond.id, r.alias, r.level, r.maxAge)
      }
    }
  }

  /**
   * Security sweep 2 (finding 3): bring stepup-2fa to the OTP-or-deny shape (see
   * STEPUP_2FA_SECOND_FACTOR). Idempotent and crash-safe: the replacement is
   * built and enabled FIRST and the legacy REQUIRED OTP form is deleted LAST, so
   * a run that dies half way leaves a flow that still demands a second factor,
   * and a rerun resumes from what it finds. A stepup-2fa with no OTP form at all
   * is structural drift that the step-up rebuild owns; this leaves it alone.
   */
  async ensureStepup2faSecondFactor(realm: string): Promise<void> {
    const listing = `/authentication/flows/stepup-2fa/executions`
    const top = (await this.realmGet<FlowExecRep[]>(realm, listing)) ?? []
    if (stepup2faGateProblem(top) === null) return
    const legacy = top.filter((e) => e.providerId === 'auth-otp-form' && (e.level ?? 0) === 0)
    let sub = top.find(isSecondFactorSubflow)
    if (!sub && legacy.length === 0) return
    if (!sub) {
      await this.realmReq(realm, 'POST', `${listing}/flow`, {
        alias: STEPUP_2FA_SECOND_FACTOR,
        type: 'basic-flow',
      })
      sub = ((await this.realmGet<FlowExecRep[]>(realm, listing)) ?? []).find(isSecondFactorSubflow)
      if (!sub?.id) throw new Error(`ensureStepup2faSecondFactor: the "${STEPUP_2FA_SECOND_FACTOR}" subflow is absent from realm "${realm}" after create`)
    }
    const kidsPath = `/authentication/flows/${encodeURIComponent(STEPUP_2FA_SECOND_FACTOR)}/executions`
    let kids = (await this.realmGet<FlowExecRep[]>(realm, kidsPath)) ?? []
    let added = false
    for (const provider of ['auth-otp-form', 'deny-access-authenticator']) {
      if (!kids.some((k) => k.providerId === provider)) {
        await this.realmReq(realm, 'POST', `${kidsPath}/execution`, { provider })
        added = true
      }
    }
    if (added) kids = (await this.realmGet<FlowExecRep[]>(realm, kidsPath)) ?? []
    const otp = kids.find((k) => k.providerId === 'auth-otp-form')
    const deny = kids.find((k) => k.providerId === 'deny-access-authenticator')
    if (!sub.id || !otp?.id || !deny?.id) {
      throw new Error(`ensureStepup2faSecondFactor: the "${STEPUP_2FA_SECOND_FACTOR}" subflow of realm "${realm}" is incomplete after the build`)
    }
    // OTP is tried first; deny-access only when no OTP alternative applied.
    if ((otp.index ?? 0) > (deny.index ?? 0)) {
      await this.realmReq(realm, 'POST', `/authentication/executions/${otp.id}/raise-priority`)
    }
    if (sub.requirement !== 'REQUIRED') await this.setReq(realm, sub.id, 'REQUIRED')
    if (otp.requirement !== 'ALTERNATIVE') await this.setReq(realm, otp.id, 'ALTERNATIVE')
    if (deny.requirement !== 'ALTERNATIVE') await this.setReq(realm, deny.id, 'ALTERNATIVE')
    for (const e of legacy) {
      if (e.id) await this.realmReq(realm, 'DELETE', `/authentication/executions/${e.id}`)
    }
  }

  // ── TASK-043: the customer lifecycle's realm operations ─────────────────────

  /** The non-secret smtpServer fields (Keycloak answers a set password as its
   *  mask, so only whether one is set is reported, never its value). */
  async getRealmSmtp(realm: string): Promise<{ host: string | null; port: string | null; user: string | null; from: string | null; starttls: string | null; passwordSet: boolean }> {
    const rep = await this.realmGet<{ smtpServer?: Record<string, unknown> }>(realm, '')
    const s = rep?.smtpServer ?? {}
    const str = (k: string): string | null => (typeof s[k] === 'string' && s[k] !== '' ? (s[k] as string) : null)
    return { host: str('host'), port: str('port'), user: str('user'), from: str('from'), starttls: str('starttls'), passwordSet: str('password') !== null }
  }

  async isRealmEnabled(realm: string): Promise<boolean> {
    const rep = await this.realmGet<{ enabled?: boolean }>(realm, '')
    return rep?.enabled === true
  }

  /**
   * Suspend (false): the realm disabled, its notBefore moved to now (every
   * token issued before is refused) and every session logged out -- in that
   * order, so no new session starts between the logout and the disable.
   * Resume (true): the realm enabled again. Partial PUTs (KC merges them).
   */
  async setRealmEnabled(realm: string, enabled: boolean, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<void> {
    if (enabled) {
      await this.realmReq(realm, 'PUT', '', { realm, enabled: true })
      return
    }
    await this.realmReq(realm, 'PUT', '', { realm, enabled: false, notBefore: nowSeconds })
    await this.realmReq(realm, 'POST', '/logout-all')
  }

  /**
   * TASK-031: the id of the user with exactly this e-mail in the realm, or
   * null. Read-only (the member import's preflight must not create anyone).
   */
  async findUserIdByEmail(realm: string, email: string): Promise<string | null> {
    const wanted = email.toLowerCase()
    const users =
      (await this.realmGet<Array<{ id?: string; email?: string }>>(realm, `/users?email=${encodeURIComponent(wanted)}&exact=true`)) ?? []
    return users.find((u) => u.email?.toLowerCase() === wanted)?.id ?? null
  }

  /**
   * TASK-043 FLOW-IDN-002 / Q9: a first administrator. Never an operator-set
   * password: the user gets UPDATE_PASSWORD + CONFIGURE_TOTP and ONE
   * execute-actions mail, sent from the realm's own sender. Idempotent and
   * crash-safe: a user that exists (created now, found by email, or a 409 on
   * create) is ADOPTED; the invite is recorded on the user
   * (attribute gremion_invited_at) and sent only while that mark is absent, so
   * a rerun sends nothing and a crash between create and send still invites.
   */
  async ensureInvitedUser(
    realm: string,
    spec: {
      email: string
      realmRole: string | null
      lifespanSeconds?: number
      /** Default: the administrator pair, UPDATE_PASSWORD + CONFIGURE_TOTP (043). TASK-031 D-5: an imported member gets ['UPDATE_PASSWORD'] only. */
      requiredActions?: readonly string[]
      /** Set on CREATE only; an existing user's names are never updated. */
      firstName?: string
      lastName?: string
      /** A found, never-invited user that already holds a credential is linked, not mailed. */
      skipIfHasCredential?: boolean
    },
    nowIso: () => string = () => new Date().toISOString(),
  ): Promise<{ id: string; created: boolean; invited: boolean }> {
    const requiredActions = [...(spec.requiredActions ?? ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'])]
    // Errors below name the realm and the step, NEVER the address: the member import's
    // errors land in the append-only request events and the audit log (TASK-031).
    const email = spec.email.toLowerCase()
    const find = async () =>
      (await this.realmGet<Array<{ id?: string; email?: string; attributes?: Record<string, string[]> }>>(
        realm,
        `/users?email=${encodeURIComponent(email)}&exact=true`,
      )) ?? []
    let found = (await find()).find((u) => u.email?.toLowerCase() === email)
    let created = false
    if (!found) {
      try {
        await this.realmReq(realm, 'POST', '/users', {
          username: email,
          email,
          emailVerified: false,
          enabled: true,
          requiredActions,
          ...(spec.firstName ? { firstName: spec.firstName } : {}),
          ...(spec.lastName ? { lastName: spec.lastName } : {}),
        })
        created = true
      } catch (err) {
        if (statusFrom(err) !== 409) throw err
      }
      found = (await find()).find((u) => u.email?.toLowerCase() === email)
    }
    const id = found?.id
    if (!id) throw new Error(`ensureInvitedUser: the user is absent from realm "${realm}" after create`)
    if (spec.realmRole) {
      const role = await this.realmGet<Record<string, unknown>>(realm, `/roles/${encodeURIComponent(spec.realmRole)}`)
      if (!role) throw new Error(`ensureInvitedUser: realm role "${spec.realmRole}" not found in realm "${realm}"`)
      await this.realmReq(realm, 'POST', `/users/${id}/role-mappings/realm`, [role])
    }
    if (found?.attributes?.[INVITE_MARK]?.length) return { id, created, invited: false }
    if (spec.skipIfHasCredential && !created) {
      const creds = (await this.realmGet<unknown[]>(realm, `/users/${id}/credentials`)) ?? []
      if (creds.length > 0) return { id, created, invited: false }
    }
    // Before any mail: the mark must be able to persist (review B2 MEDIUM, r2).
    await this.ensureInviteMarkDeclared(realm)
    const lifespan = spec.lifespanSeconds ?? 72 * 3600
    await this.realmReq(realm, 'PUT', `/users/${id}/execute-actions-email?lifespan=${lifespan}`, requiredActions)
    // The FULL representation: on Keycloak 24+ a PUT carrying `attributes`
    // replaces the user's attribute set, root attributes included.
    const user = await this.realmGet<Record<string, unknown> & { attributes?: Record<string, string[]> }>(realm, `/users/${id}`)
    if (!user) throw new Error(`ensureInvitedUser: the user vanished from realm "${realm}" after the invite`)
    await this.realmReq(realm, 'PUT', `/users/${id}`, { ...user, attributes: { ...user.attributes, [INVITE_MARK]: [nowIso()] } })
    const back = await this.realmGet<{ attributes?: Record<string, string[]> }>(realm, `/users/${id}`)
    if (!back?.attributes?.[INVITE_MARK]?.length) {
      throw new Error(
        `ensureInvitedUser: the invite mark ${INVITE_MARK} did not persist on the user in realm "${realm}" (is it declared in the user profile?); a rerun would invite again`,
      )
    }
    return { id, created, invited: true }
  }

  /**
   * Declares the send-once invite mark in the realm's user profile, admin-only
   * (view/edit: admin), so Keycloak 24+ keeps it: an undeclared attribute is
   * dropped on write while unmanaged attributes are disabled (the default).
   * Read-modify-write of the realm's own profile, every other attribute and
   * group kept; no realm-wide unmanagedAttributePolicy is switched on. Returns
   * whether it wrote. Refuses loudly when the profile cannot be read.
   */
  async ensureInviteMarkDeclared(realm: string): Promise<boolean> {
    const profile = await this.realmGet<{ attributes?: Array<{ name?: string }> } & Record<string, unknown>>(realm, '/users/profile')
    if (!profile || !Array.isArray(profile.attributes)) {
      throw new Error(`ensureInviteMarkDeclared: the user profile of realm "${realm}" cannot be read; no invite is sent`)
    }
    if (profile.attributes.some((a) => a.name === INVITE_MARK)) return false
    await this.realmReq(realm, 'PUT', '/users/profile', {
      ...profile,
      attributes: [
        ...profile.attributes,
        { name: INVITE_MARK, displayName: 'Gremion invitation sent', permissions: { view: ['admin'], edit: ['admin'] }, multivalued: false },
      ],
    })
    return true
  }

  /**
   * #164 step-up: build/refresh the LoA browser-stepup flow + otpPolicy + acr
   * mapper on the realm. Idempotent. (Ported from configure_stepup_flow.)
   */
  async configureStepupFlow(realm: string): Promise<void> {
    // 1. Build browser-stepup if absent (the build is not individually idempotent).
    const flows = await this.realmGet<Array<{ alias?: string }>>(realm, '/authentication/flows')
    const exists = (flows ?? []).some((f) => f.alias === 'browser-stepup')
    if (!exists) {
      await this.realmReq(realm, 'POST', '/authentication/flows/browser/copy', { newName: 'browser-stepup' })
      const execs = await this.realmGet<Array<{ id: string; providerId?: string; displayName?: string }>>(
        realm,
        '/authentication/flows/browser-stepup/executions',
      )
      const pwId = execs.find((e) => e.providerId === 'auth-username-password-form')?.id
      const twofaId = execs.find((e) => e.displayName === 'browser-stepup Browser - Conditional 2FA')?.id
      if (pwId) await this.realmReq(realm, 'DELETE', `/authentication/executions/${pwId}`)
      if (twofaId) await this.realmReq(realm, 'DELETE', `/authentication/executions/${twofaId}`)
      // Add the two LoA subflows under "browser-stepup forms" (1FA before 2FA).
      const forms = 'browser-stepup%20forms'
      await this.realmReq(realm, 'POST', `/authentication/flows/${forms}/executions/flow`, {
        alias: 'stepup-1fa',
        type: 'basic-flow',
      })
      await this.realmReq(realm, 'POST', `/authentication/flows/${forms}/executions/flow`, {
        alias: 'stepup-2fa',
        type: 'basic-flow',
      })
      await this.realmReq(realm, 'POST', '/authentication/flows/stepup-1fa/executions/execution', {
        provider: 'conditional-level-of-authentication',
      })
      await this.realmReq(realm, 'POST', '/authentication/flows/stepup-1fa/executions/execution', {
        provider: 'auth-username-password-form',
      })
      await this.realmReq(realm, 'POST', '/authentication/flows/stepup-2fa/executions/execution', {
        provider: 'conditional-level-of-authentication',
      })
      await this.realmReq(realm, 'POST', '/authentication/flows/stepup-2fa/executions/execution', {
        provider: 'auth-otp-form',
      })
      // Resolve the new execution ids per subflow (unambiguous via per-subflow GET).
      const e1 = await this.realmGet<Array<{ id: string; providerId?: string }>>(
        realm,
        '/authentication/flows/stepup-1fa/executions',
      )
      const c1 = e1.find((e) => e.providerId === 'conditional-level-of-authentication')?.id
      const p1 = e1.find((e) => e.providerId === 'auth-username-password-form')?.id
      const e2 = await this.realmGet<Array<{ id: string; providerId?: string }>>(
        realm,
        '/authentication/flows/stepup-2fa/executions',
      )
      const c2 = e2.find((e) => e.providerId === 'conditional-level-of-authentication')?.id
      const o2 = e2.find((e) => e.providerId === 'auth-otp-form')?.id
      const top = await this.realmGet<Array<{ id: string; displayName?: string }>>(
        realm,
        '/authentication/flows/browser-stepup/executions',
      )
      const f1 = top.find((e) => e.displayName === 'stepup-1fa')?.id
      const f2 = top.find((e) => e.displayName === 'stepup-2fa')?.id
      if (f1) await this.setReq(realm, f1, 'CONDITIONAL')
      if (c1) await this.setReq(realm, c1, 'REQUIRED')
      if (p1) await this.setReq(realm, p1, 'REQUIRED')
      if (f2) await this.setReq(realm, f2, 'CONDITIONAL')
      if (c2) await this.setReq(realm, c2, 'REQUIRED')
      if (o2) await this.setReq(realm, o2, 'REQUIRED')
      if (c1) await this.setCfg(realm, c1, 'stepup-loa1', '1', '36000')
      if (c2) await this.setCfg(realm, c2, 'stepup-loa2', '2', '300')
    }

    // 1b. Security sweep 2 (finding 3): the 2FA subflow must be OTP-or-deny. Also
    //    runs for a freshly built flow, whose OTP form was created REQUIRED above,
    //    and BEFORE the realm is pointed at the flow (step 2): a crash between the
    //    two must never leave a live realm in the enrol-then-loa2 shape.
    await this.ensureStepup2faSecondFactor(realm)

    // 2. Realm otpPolicy + acr.loa.map + browserFlow. Minimal partial PUT (a full
    //    round-tripped realm rep 500s on KC 26); merge existing attributes. Runs
    //    AFTER the flow exists.
    const realmRep = await this.realmGet<{ attributes?: Record<string, unknown> }>(realm, '')
    const attrs = { ...realmRep.attributes, 'acr.loa.map': '{"loa1":1,"loa2":2}' }
    await this.realmReq(realm, 'PUT', '', {
      realm,
      browserFlow: 'browser-stepup',
      otpPolicyType: 'totp',
      otpPolicyAlgorithm: 'HmacSHA1',
      otpPolicyDigits: 6,
      otpPolicyPeriod: 30,
      otpPolicyLookAheadWindow: 1,
      otpPolicyInitialCounter: 0,
      attributes: attrs,
    })

    // 3. Repair the Condition-LoA config on the (now-existing) flow. The build
    //    above writes the LoA configs only when it CREATES the flow; this brings an
    //    EXISTING flow whose loa1/loa2 level or maxAge has drifted back to contract
    //    (#164: loa1 level 1 / maxAge 36000, loa2 level 2 / maxAge 300). Idempotent.
    await this.repairStepupLoaConfig(realm)

    // 4. Ensure the gremion-ui client emits the acr claim (access + id token).
    const clients = await this.realmGet<Array<{ id?: string }>>(realm, '/clients?clientId=gremion-ui')
    const uuid = clients[0]?.id
    if (uuid) {
      const mappers = await this.realmGet<Array<{ protocolMapper?: string }>>(
        realm,
        `/clients/${uuid}/protocol-mappers/models`,
      )
      const hasAcr = mappers.some((m) => m.protocolMapper === 'oidc-acr-mapper')
      if (!hasAcr) {
        await this.realmReq(realm, 'POST', `/clients/${uuid}/protocol-mappers/models`, {
          name: 'acr',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-acr-mapper',
          config: {
            'id.token.claim': 'true',
            'access.token.claim': 'true',
            'introspection.token.claim': 'true',
          },
        })
      }
    }
  }
}
