// Recording fakes for every port (TASK-043 unit suite). Each fake keeps the
// state a real adapter would read back, and appends to `mutations` ONLY when a
// call changes that state -- so "a rerun makes zero mutating calls" is an
// assertion on this list, not on call counts.
import { EnableRefused, type EnableGate, type EnableRefusedCode, type UnprovenEnablement } from '@gremion/tenant-store/lifecycle'
import { memoryLedger } from '../src/ledger.ts'
import type { AdminSpec, ControlRow, CustomerRef, DpiaSpec, GatePort, KernelPostCondition, ProvisioningDeps, SmtpReadBack } from '../src/ports.ts'

export const OPERATOR = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
/** The release tip the fake gate runs on (GREMION_RELEASE_TIP). */
export const TIP = 'a1'.repeat(20)
/** A written DPIA decision as the create request carries it (lane note D2). */
export const DPIA: DpiaSpec = { requiresDpia: 'no', reasonCodes: ['no_special_category'], documentRef: 'TOM-Anhang 4.1' }
export const PLATFORM_DOMAIN = 'platform.example'
export const ADMINS: AdminSpec[] = [
  { role: 'it-admin', email: 'it@customer.example' },
  { role: 'council-admin', email: 'council@customer.example' },
]
/**
 * A synthetic catalogue module that declares no export and is NOT in
 * PROVISIONAL_RETENTION_PROFILES: what `init` still leaves undecided (the Q20
 * stop-and-ask), so the refusal guards keep a module that is really unloaded
 * now that the five database-less modules carry provisional profiles (R29-I24).
 */
export const UNDECIDED_MODULE = 'undecided_probe'
const NO_BROKER = new Set(['board', 'files', 'messaging', 'vault', 'votes', 'elections', 'handover', UNDECIDED_MODULE])
const FLOWS = new Set(['kernel', 'publishing', 'content', 'calendar', 'finance'])

let seq = 0
function uuidv7(): string {
  seq++
  const hex = seq.toString(16).padStart(12, '0')
  return `01927f00-0000-7000-8000-${hex}`
}

export interface World {
  mutations: string[]
  control: Map<string, ControlRow>
  config: Map<string, { modules: string[]; setupComplete: boolean }>
  realms: Map<string, { enabled: boolean; smtp: SmtpReadBack; users: Map<string, AdminSpec>; notBefore: number; mails: string[] }>
  kernel: Map<string, { exists: boolean; migrated: boolean; seedRows: string[]; ledgerColumns: string[]; orgUnits: number; committees: number }>
  groups: Map<string, string[]>
  prefixes: Set<string>
  broker: Map<string, string[]>
  enabled: Map<string, Map<string, { gateRefs: [string, string]; by: string }>>
  /** TASK-044: the release tip the gate compares with (null: unset). */
  tip: string | null
  /** TASK-044: the latest cross_customer result per module (absent: none recorded). */
  isolation: Map<string, { id: string; passed: boolean; tip: string }>
  /** TASK-044: DPIA decisions per `${customerId}/${module}`, oldest first. */
  dpia: Map<string, { id: string; decision: DpiaSpec; operatorId: string }[]>
  /** Test knobs. */
  knobs: { seedsOn: boolean; runnerShape: 'gremion-ui' | 'tenant-store'; dnsFails: boolean; crashAfterRegister?: boolean }
  /**
   * Catalogue modules with NO plt.module_version row: what `init` leaves
   * undecided under Q20 (no retention profile declared and not in the
   * provisional table; the synthetic UNDECIDED_MODULE), so enableModule would
   * throw MODULE_VERSION_UNKNOWN for them (review B1 LOW, r2: the fake used to
   * enable them happily).
   */
  unloaded: Set<string>
}

export function world(): World {
  return {
    mutations: [],
    control: new Map(),
    config: new Map(),
    realms: new Map(),
    kernel: new Map(),
    groups: new Map(),
    prefixes: new Set(),
    broker: new Map(),
    enabled: new Map(),
    tip: TIP,
    // every module but the denied ones holds a current-tip pass unless a test says not
    isolation: new Map(['calendar', 'publishing', 'votes', UNDECIDED_MODULE].map((m) => [m, { id: uuidv7(), passed: true, tip: TIP }])),
    dpia: new Map(),
    knobs: { seedsOn: false, runnerShape: 'gremion-ui', dnsFails: false },
    unloaded: new Set([UNDECIDED_MODULE]),
  }
}

const emptySmtp = (): SmtpReadBack => ({ host: null, port: null, user: null, from: null, starttls: null })

/** What the host's `gremion-vendor-mail realm-smtp --tenant` leaves in the realm. */
export function hostStamp(w: World, c: { realm: string; token: string }, user = `kc-${c.token}@${PLATFORM_DOMAIN}`): void {
  const r = w.realms.get(c.realm)
  if (!r) throw new Error(`no realm ${c.realm}`)
  r.smtp = { host: `mail.${PLATFORM_DOMAIN}`, port: '587', user, from: user, starttls: 'true' }
  w.mutations.push(`host:stamp ${c.realm}`)
}

export function deps(w: World, catalogue = ['board', 'calendar', 'publishing', 'vault', 'votes', UNDECIDED_MODULE]): ProvisioningDeps & { ledger: ReturnType<typeof memoryLedger> } {
  const ledger = memoryLedger()
  const m = (s: string) => w.mutations.push(s)
  const pc = (c: CustomerRef): KernelPostCondition => {
    const k = w.kernel.get(c.id)
    if (!k) throw new Error('no kernel db')
    return { ledgerColumns: k.ledgerColumns, seedRows: k.seedRows, orgUnits: k.orgUnits, committees: k.committees }
  }
  const origAppend = ledger.append.bind(ledger)
  ledger.append = async (...a) => {
    if (a[2] !== 'pending') m(`ledger:${a[1]}=${a[2]}`)
    return origAppend(...a)
  }
  return {
    platformDomain: PLATFORM_DOMAIN,
    ledger,
    control: {
      async getBySlug(slug) {
        return w.control.get(slug) ?? null
      },
      async registerProvisioning({ slug, host, realm }) {
        // MED-2: a crash between registerTenant and addTenantDomain leaves host null
        const crash = w.knobs.crashAfterRegister
        const row: ControlRow = { id: uuidv7(), slug, status: 'provisioning', realm, host: crash ? null : host }
        w.control.set(slug, row)
        m(`control:register ${slug}`)
        if (crash) {
          w.knobs.crashAfterRegister = false
          throw new Error('crash between registerTenant and addTenantDomain')
        }
        return row
      },
      async bindPrimaryHost(id, host) {
        const row = [...w.control.values()].find((r) => r.id === id)
        if (!row) throw new Error('no row')
        row.host = host
        m(`control:bind-host ${row.slug}`)
      },
      async setStatus(id, status) {
        const row = [...w.control.values()].find((r) => r.id === id)
        if (!row) throw new Error('no row')
        if (row.status === status) return
        row.status = status
        m(`control:status ${row.slug}=${status}`)
      },
    },
    config: {
      async ensure(c) {
        if (w.config.has(c.slug)) return false
        w.config.set(c.slug, { modules: [], setupComplete: false })
        m(`config:write ${c.slug}`)
        return true
      },
      async setupComplete(c) {
        return w.config.get(c.slug)?.setupComplete ?? false
      },
      async markSetupComplete(c) {
        const cur = w.config.get(c.slug)
        if (!cur) throw new Error('no config')
        cur.setupComplete = true
        m(`config:setup-complete ${c.slug}`)
      },
    },
    realm: {
      async ensureRealm(c) {
        if (w.realms.has(c.realm)) return
        w.realms.set(c.realm, { enabled: true, smtp: emptySmtp(), users: new Map(), notBefore: 0, mails: [] })
        m(`kc:create-realm ${c.realm}`)
      },
      async readSmtp(realm) {
        return { ...(w.realms.get(realm)?.smtp ?? emptySmtp()) }
      },
      async ensureAdmins(c, admins) {
        const r = w.realms.get(c.realm)
        if (!r) throw new Error('no realm')
        const created: string[] = []
        const invited: string[] = []
        for (const a of admins) {
          if (r.users.has(a.email)) continue
          r.users.set(a.email, a)
          r.mails.push(`${r.smtp.from} -> ${a.email}`)
          created.push(a.email)
          invited.push(a.email)
          m(`kc:user ${c.realm}/${a.email}`)
        }
        return { created, invited }
      },
      async isEnabled(realm) {
        return w.realms.get(realm)?.enabled ?? false
      },
      async setEnabled(realm, enabled) {
        const r = w.realms.get(realm)
        if (!r) throw new Error('no realm')
        r.enabled = enabled
        if (!enabled) r.notBefore = Date.now()
        m(`kc:enabled ${realm}=${enabled}`)
      },
    },
    kernel: {
      async ensureDatabase(c) {
        if (w.kernel.get(c.id)?.exists) return
        w.kernel.set(c.id, { exists: true, migrated: false, seedRows: [], ledgerColumns: [], orgUnits: 0, committees: 0 })
        m(`pg:create-kernel ${c.id}`)
      },
      async migrate(c) {
        const k = w.kernel.get(c.id)
        if (!k) throw new Error('no kernel db')
        if (k.migrated) return
        k.migrated = true
        k.ledgerColumns = w.knobs.runnerShape === 'gremion-ui' ? ['filename', 'applied_at'] : ['filename', 'sha256', 'applied_at']
        if (w.knobs.seedsOn) {
          k.seedRows = ['0005_dev_seed.sql']
          k.orgUnits = 3
          k.committees = 2
        }
        m(`pg:migrate-kernel ${c.id}`)
      },
      async postCondition(c) {
        return pc(c)
      },
    },
    domain: {
      async assertBound(c) {
        if (w.knobs.dnsFails) throw new Error(`${c.host} does not resolve`)
        if (w.control.get(c.slug)?.host !== c.host) throw new Error('not bound')
      },
    },
    storage: {
      async reservePrefix(c) {
        if (w.prefixes.has(c.id)) return
        w.prefixes.add(c.id)
        m(`storage:reserve ${c.id}`)
      },
    },
    firstBody: {
      async ensure(c) {
        const k = w.kernel.get(c.id)
        if (!k) throw new Error('no kernel db')
        if (k.orgUnits >= 1) return { created: false }
        k.orgUnits = 1
        w.groups.set(c.realm, ['council'])
        m(`body:create ${c.slug}`)
        return { created: true }
      },
    },
    broker: {
      async ensure(c, modules) {
        const users = ['kernel', ...modules.filter((x) => FLOWS.has(x))].sort()
        for (const x of modules) if (!FLOWS.has(x) && !NO_BROKER.has(x)) throw new Error(`module ${x} is in neither FLOWS nor NO_BROKER`)
        const before = w.broker.get(c.slug)
        const same = JSON.stringify(before) === JSON.stringify(users)
        if (!same) {
          w.broker.set(c.slug, users)
          m(`nats:ensure ${c.slug}=[${users.join(',')}]`)
        }
        return {
          accountRef: `T_${c.slug}`,
          reloaded: !same,
          createdUsers: users.filter((u) => !(before ?? []).includes(u)),
          removedUsers: (before ?? []).filter((u) => !users.includes(u)),
        }
      },
    },
    modules: {
      catalogueIds: () => catalogue,
      async unloaded(ids) {
        return ids.filter((id) => w.unloaded.has(id))
      },
      async enable(c, moduleId, gate: EnableGate, operatorId) {
        const mine = w.enabled.get(c.id) ?? new Map()
        if (mine.has(moduleId)) return { noop: true, database: null }
        if (w.unloaded.has(moduleId)) throw Object.assign(new Error(`module ${moduleId} has no plt.module_version`), { code: 'MODULE_VERSION_UNKNOWN' })
        const g = await gate(c.id, moduleId)
        if (!g) throw Object.assign(new Error(`the enable gate refused (${c.id}, ${moduleId})`), { code: 'GATE_REFUSED' })
        mine.set(moduleId, { gateRefs: [g.isolationTestResultId, g.dpiaDecisionId], by: operatorId })
        w.enabled.set(c.id, mine)
        m(`pg:enable ${c.slug}/${moduleId}`)
        return { noop: false, database: `t_x__${moduleId}` }
      },
      async disable(c, moduleId) {
        const mine = w.enabled.get(c.id)
        if (!mine?.has(moduleId)) return { noop: true, dropped: false, database: null, export: null }
        mine.delete(moduleId)
        m(`pg:disable ${c.slug}/${moduleId}`)
        return { noop: false, dropped: true, database: `t_x__${moduleId}`, export: { path: `/exports/${moduleId}.dump`, sha256: 'a'.repeat(64), bytes: 10 } }
      },
      async enabled(c) {
        return [...(w.enabled.get(c.id)?.keys() ?? [])]
      },
    },
    gate: fakeGate(w),
  }
}

/**
 * The gate the way lifecycle/enable-gate answers, over the world's isolation
 * results and DPIA decisions (the real one is proven against PostgreSQL in
 * tenant-store's lifecycle-enable-gate integration spec).
 */
export function fakeGate(w: World): GatePort {
  const refuse = (code: EnableRefusedCode, m: string, c: string | null, why: string) => new EnableRefused(code, `module ${m} for ${c ?? 'a customer not created yet'}: ${why}`, m, c, w.tip)
  const isolation = (m: string, c: string | null): string => {
    if (w.tip === null) throw new EnableRefused('NO_RELEASE_TIP', `module ${m}: the release tip is unset`, m, c, null)
    const r = w.isolation.get(m)
    if (!r) throw refuse('NO_ISOLATION_RESULT', m, c, 'no result')
    if (!r.passed) throw refuse('ISOLATION_FAILED', m, c, 'failed')
    if (r.tip !== w.tip) throw refuse('ISOLATION_STALE_TIP', m, c, `passed on ${r.tip}`)
    return r.id
  }
  const latestDpia = (c: string, m: string) => w.dpia.get(`${c}/${m}`)?.at(-1)
  const enableGate: EnableGate = async (c, m) => {
    const iso = isolation(m, c)
    const d = latestDpia(c, m)
    if (!d || !d.decision.documentRef) throw refuse('NO_DPIA_DECISION', m, c, 'no written decision')
    return { isolationTestResultId: iso, dpiaDecisionId: d.id, crossBodyTestResultId: null }
  }
  return {
    get releaseTipSha() {
      return w.tip
    },
    enableGate,
    async assertIsolationProven(keys, c) {
      for (const k of keys) isolation(k, c)
    },
    async hasDpiaDecision(c, m) {
      return !!latestDpia(c, m)?.decision.documentRef
    },
    async recordDpia(c, m, decision, operatorId) {
      const cur = latestDpia(c, m)
      if (cur && JSON.stringify(cur.decision) === JSON.stringify(decision)) return { dpiaDecisionId: cur.id, created: false }
      const id = uuidv7()
      w.dpia.set(`${c}/${m}`, [...(w.dpia.get(`${c}/${m}`) ?? []), { id, decision: { ...decision, reasonCodes: [...decision.reasonCodes] }, operatorId }])
      w.mutations.push(`ops:dpia ${m}`)
      return { dpiaDecisionId: id, created: true }
    },
    async unproven(customerId) {
      const out: UnprovenEnablement[] = []
      for (const [cid, mods] of w.enabled) {
        if (customerId !== undefined && cid !== customerId) continue
        for (const [m, e] of mods) {
          try {
            const g = await enableGate(cid, m)
            if (g?.isolationTestResultId !== e.gateRefs[0]) throw refuse('ISOLATION_STALE_TIP', m, cid, 'stored reference is not the current pass')
          } catch (err) {
            if (!(err instanceof EnableRefused)) throw err
            out.push({ customerId: cid, moduleKey: m, isolationTestResultId: e.gateRefs[0], dpiaDecisionId: e.gateRefs[1], codes: [err.code], reason: err.reason })
          }
        }
      }
      return out
    },
  }
}
