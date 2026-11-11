// E3 (finding 4): the Systemstatus rows are live probes, run when the page loads.
//
// The page used to render the provisioning ledger (tenant_provisioning_resource).
// A tenant wired by hand, or wired after its first boot, keeps ledger rows in
// "pending" for ever, so a customer whose services all answered was told that it
// was "still converging" and that Nextcloud and Matrix were waiting. A ledger
// records provisioning history, not whether a service answers now.
//
// What the app can check by itself, and what this file reports:
//   * db         - the tenant's own database answers a trivial query.
//   * keycloak   - the realm's OIDC discovery document answers.
//   * nextcloud  - the files module's liveness probe, while the module is switched on.
//   * matrix     - the messaging module's liveness probe, while the module is switched on.
// A module probe is matched by its module id, or by its service name when it sets none.
// A module service whose module registers no probe in this deployment gets no row:
// the page does not name a component that is not there. A module that is switched
// off is "off", not a fault. A probe that throws, answers false or exceeds the
// time limit is "unreachable".
import type { SetupHealthProbe } from '$lib/server/modules/runtime-registry'

export type ProbeStatus = 'ok' | 'unreachable' | 'off'
export type ProbedKey = 'db' | 'keycloak' | 'nextcloud' | 'matrix'

export interface ProbedService {
  key: ProbedKey
  status: ProbeStatus
}

export interface ProbeDeps {
  /** Resolves when the tenant database answers; rejects otherwise. */
  db: () => Promise<unknown>
  /** True when the realm's discovery document answers. */
  keycloak: () => Promise<boolean>
  /** The tenant's module switches (a missing key counts as off, like the module gate).
   *  `null` means the config could not be read: the module switches are unknown, so no
   *  module row is listed and no module probe runs (a module is neither "off" nor probed). */
  modules: Record<string, boolean> | null
  /** The liveness probes the modules registered. A probe is matched to its module by
   *  `moduleId` when it sets one, else by its `service` name (the files and messaging
   *  modules register `{ service, validate }` only). Probes that match neither are ignored. */
  moduleProbes: readonly Pick<SetupHealthProbe, 'moduleId' | 'service' | 'validate'>[]
  /** Per-probe time limit; default 3000 ms. */
  timeoutMs?: number
}

/** The module services shown on the page, and the module id that owns each. */
const MODULE_SERVICES: readonly { key: 'nextcloud' | 'matrix'; moduleId: string; service: string }[] = [
  { key: 'nextcloud', moduleId: 'files', service: 'nextcloud' },
  { key: 'matrix', moduleId: 'messages', service: 'synapse' },
]

// A failed probe is logged with the row key and a reason class only: the error
// message of a driver or HTTP client can carry connection details.
function logFailure(key: ProbedKey, reason: string): void {
  console.warn(`[systemstatus] probe ${key} failed: ${reason}`)
}

async function reachable(key: ProbedKey, run: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(run)
        .then((v) => v !== false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          logFailure(key, 'timeout')
          resolve(false)
        }, timeoutMs)
      }),
    ])
    if (!result && !timedOut) logFailure(key, 'answered not ok')
    return result
  } catch (err) {
    logFailure(key, err instanceof Error ? err.name : 'non-error rejection')
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function probeServices(deps: ProbeDeps): Promise<ProbedService[]> {
  const timeoutMs = deps.timeoutMs ?? 3000
  const status = (ok: boolean): ProbeStatus => (ok ? 'ok' : 'unreachable')

  const switches = deps.modules
  const modulePlan = MODULE_SERVICES.flatMap((m) => {
    if (!switches) return []
    const probe = deps.moduleProbes.find((p) => (p.moduleId ? p.moduleId === m.moduleId : p.service === m.service))
    return probe ? [{ key: m.key, moduleId: m.moduleId, probe }] : []
  })

  const [db, keycloak, ...modules] = await Promise.all([
    reachable('db', deps.db, timeoutMs),
    reachable('keycloak', deps.keycloak, timeoutMs),
    ...modulePlan.map(async (m): Promise<ProbedService> => {
      if (!switches?.[m.moduleId]) return { key: m.key, status: 'off' }
      return { key: m.key, status: status(await reachable(m.key, m.probe.validate, timeoutMs)) }
    }),
  ])

  return [{ key: 'db', status: status(db) }, { key: 'keycloak', status: status(keycloak) }, ...modules]
}
