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

    // 2. Realm otpPolicy + acr.loa.map + browserFlow. Minimal partial PUT (a full
    //    round-tripped realm rep 500s on KC 26); merge existing attributes. Runs
    //    AFTER the flow exists.
    const realmRep = await this.realmGet<{ attributes?: Record<string, unknown> }>(realm, '')
    const attrs = { ...(realmRep.attributes ?? {}), 'acr.loa.map': '{"loa1":1,"loa2":2}' }
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
