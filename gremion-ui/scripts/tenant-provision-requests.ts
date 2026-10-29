// gremion-ui/scripts/tenant-provision-requests.ts — TASK-043d-1: the
// tenant-create one-shot's request verbs (the host-side executor's container
// half). Its own file (R31 O9): tenant-provision.ts carries one import, one
// dispatch line, its USAGE line and the executor role in `init`.
//
//   request-verify <request-id>
//     The trusted-layer verdict on ONE claimed request, as ONE JSON line on
//     STDOUT, before the executor runs anything (TASK-043d D4/D6):
//       {"verdict":"ok","kind",...,"args":{...normalised...}}
//       {"verdict":"refused","reason":"..."}
//     It reads the request AS the platform owner (the container's own
//     credential), checks the kind and its args (@gremion/provisioning
//     requests.ts, which reuses validateCreate), the evidence (a panel
//     request: the signed ID + access token pair of the operator's loa2
//     sign-in, verified against the ops realm's JWKS; a break-glass request:
//     its reason and host actor, recorded by the database), and re-reads the
//     operator in the ops realm (exists, enabled, holds `operator`) with the
//     provisioner's credential. Read-only: it writes nothing; the executor
//     marks the request verified (which clears the token) and finishes it.
//     EXIT 0 with a verdict; 1 when it could not decide (the database, the
//     JWKS or the ops realm unreachable); 2 usage.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRemoteJWKSet } from 'jose'
import postgres from 'postgres'
import { modulesToEnable, verifyEnableLoaded, verifyRequestArgs, type RequestVerdict } from '@gremion/provisioning'
import { lookupModuleVersion, type LifecycleModule } from '@gremion/tenant-store/lifecycle'
import type { KcTransport } from '../src/lib/server/tenant/provisioner/kc-admin-api'
import { verifyRequestEvidence } from '../src/lib/server/tenant/provisioner/request-verify'

export interface RequestVerbContext {
  /** process.argv after the verb */
  args: readonly string[]
  reqEnv(name: string): string
  directPostgresUrl(name: string, value: string): string
  loadModules(): LifecycleModule[]
  modulesDir: string
  kcInternalBase(): string
  /** The least-privilege provisioner's admin transport (it created the ops realm, so it reads its users). */
  provisionerTransport(): KcTransport
  usage(message: string): Error
  log(line: string): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OPS_REALM = 'platform'
const PANEL_CLIENT = 'control-panel'

interface RequestRow {
  kind: string
  customer_slug: string
  args: unknown
  origin: 'panel' | 'host'
  operator_id: string
  evidence_acr: string | null
  evidence_auth_time: Date | null
  evidence_token: string | null
  evidence_verified_at: Date | null
  host_actor: string | null
  reason: string | null
  created_at: Date
  state: string
}

/** The ids of modules/disabled.json (excluded from the default build; never enabled through a request). */
export function disabledModuleIds(modulesDir: string): string[] {
  const f = join(modulesDir, 'disabled.json')
  if (!existsSync(f)) return []
  const doc = JSON.parse(readFileSync(f, 'utf8')) as { disabled?: Array<{ id?: unknown }> }
  return (doc.disabled ?? []).map((d) => d.id).filter((id): id is string => typeof id === 'string')
}

/** The operator, re-read in the ops realm: exists, enabled, holds the operator realm role. */
async function operatorStanding(kc: KcTransport, operatorId: string): Promise<string | null> {
  let user: { enabled?: boolean } | undefined
  try {
    user = (await kc('GET', `/admin/realms/${OPS_REALM}/users/${operatorId}`)) as { enabled?: boolean } | undefined
  } catch (err) {
    if (/\b404\b/.test(err instanceof Error ? err.message : String(err))) return `operator ${operatorId} does not exist in the ops realm`
    throw err
  }
  if (user?.enabled !== true) return `operator ${operatorId} is disabled in the ops realm`
  const roles = ((await kc('GET', `/admin/realms/${OPS_REALM}/users/${operatorId}/role-mappings/realm/composite`)) as Array<{ name?: string }> | undefined) ?? []
  if (!roles.some((r) => r.name === 'operator')) return `operator ${operatorId} no longer holds the operator role`
  return null
}

function print(v: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(v)}\n`)
}

async function requestVerify(ctx: RequestVerbContext): Promise<void> {
  const id = ctx.args.find((a) => !a.startsWith('--'))
  if (!id || !UUID.test(id)) throw ctx.usage('request-verify <request-id> (a uuid)')
  const platformUrl = ctx.directPostgresUrl('PLATFORM_DATABASE_URL', ctx.reqEnv('PLATFORM_DATABASE_URL'))
  const issuer = process.env.OPS_OIDC_ISSUER || `https://${ctx.reqEnv('PLATFORM_DOMAIN')}/auth/realms/${OPS_REALM}`
  const catalogue = ctx.loadModules()
  const platform = postgres(platformUrl, { max: 1, onnotice: () => {}, connect_timeout: 15 })
  try {
    const [row] = await platform<RequestRow[]>`
      SELECT kind, customer_slug, args, origin, operator_id::text, evidence_acr, evidence_auth_time, evidence_token,
             evidence_verified_at, host_actor, reason, created_at, state
        FROM plt.provisioning_request WHERE request_id = ${id}::uuid`
    const refuse = (reason: string) => {
      ctx.log(`request-verify ${id}: refused: ${reason}`)
      print({ verdict: 'refused', reason })
    }
    if (!row) return refuse('no such request')
    if (row.state !== 'running') return refuse(`the request is ${row.state}, not running (only a claimed request is verified)`)
    // 1. the kind and its args (pure; reuses the engine's own validation)
    const verdict: RequestVerdict = verifyRequestArgs(
      { kind: row.kind, customerSlug: row.customer_slug, args: row.args, operatorId: row.operator_id },
      { catalogueIds: catalogue.map((m) => m.id), disabledIds: disabledModuleIds(ctx.modulesDir) },
    )
    if (verdict.verdict === 'refused') return refuse(verdict.reason)
    const byId = new Map(catalogue.map((m) => [m.id, m]))
    // a create and an enable_module enable modules; every other kind carries no module to load
    const notLoaded = await verifyEnableLoaded(modulesToEnable(verdict.args), async (ids) => {
      const missing: string[] = []
      for (const m of ids) {
        const mod = byId.get(m)
        if (!mod || !(await lookupModuleVersion(platform, m, mod.moduleJson.runtime.version))) missing.push(m)
      }
      return missing
    })
    if (notLoaded) return refuse(notLoaded)
    // 2. the evidence
    let evidence: string
    if (row.origin === 'host') {
      evidence = `break-glass by host user ${row.host_actor ?? '?'}: ${row.reason ?? ''}`
    } else if (row.evidence_verified_at !== null) {
      // a re-claimed request (executor restart): verified on its first claim, token since cleared
      evidence = `verified at ${row.evidence_verified_at.toISOString()} on an earlier claim`
    } else {
      if (!row.evidence_token || !row.evidence_auth_time) return refuse('a panel request without its signed evidence')
      const jwks = createRemoteJWKSet(new URL(`${ctx.kcInternalBase()}/realms/${OPS_REALM}/protocol/openid-connect/certs`))
      const e = await verifyRequestEvidence({
        evidence: row.evidence_token,
        jwks,
        issuer,
        clientId: PANEL_CLIENT,
        operatorId: row.operator_id,
        createdAt: row.created_at,
        recordedAuthTime: row.evidence_auth_time,
      })
      if (!e.ok) return refuse(`evidence: ${e.reason}`)
      evidence = `signed loa2 sign-in of ${e.sub} (${e.timeClaim} ${new Date(e.authTime * 1000).toISOString()})`
    }
    // 3. the operator, as the ops realm knows them NOW (narrows a revoked operator's window)
    const standing = await operatorStanding(ctx.provisionerTransport(), row.operator_id)
    if (standing) return refuse(standing)
    ctx.log(`request-verify ${id}: ok (${row.kind} ${row.customer_slug}; ${evidence})`)
    print({ verdict: 'ok', kind: row.kind, slug: row.customer_slug, origin: row.origin, operatorId: row.operator_id, evidence, args: verdict.args })
  } finally {
    await platform.end({ timeout: 5 })
  }
}

/** The request verbs this file serves (tenant-provision.ts dispatches them here). */
export async function requestVerb(verb: string, ctx: RequestVerbContext): Promise<void> {
  if (verb === 'request-verify') return requestVerify(ctx)
  throw ctx.usage(`unknown request verb ${verb}`)
}
