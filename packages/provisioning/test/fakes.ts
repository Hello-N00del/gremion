// Recording fakes for every port (TASK-043 unit suite). Each fake keeps the
// state a real adapter would read back, and appends to `mutations` ONLY when a
// call changes that state -- so "a rerun makes zero mutating calls" is an
// assertion on this list, not on call counts.
import type { EnableGate } from '@gremion/tenant-store/lifecycle'
import { memoryLedger } from '../src/ledger.ts'
import type { AdminSpec, ControlRow, CustomerRef, KernelPostCondition, ProvisioningDeps, SmtpReadBack } from '../src/ports.ts'

export const OPERATOR = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
export const PLATFORM_DOMAIN = 'platform.example'
export const ADMINS: AdminSpec[] = [
  { role: 'it-admin', email: 'it@customer.example' },
  { role: 'council-admin', email: 'council@customer.example' },
]
const NO_BROKER = new Set(['board', 'files', 'messaging', 'vault', 'votes', 'elections', 'handover'])
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
  attestations: Map<string, { id: string; operatorId: string; enableList: string[]; createdAt: Date }>
  /** Test knobs. */
  knobs: { seedsOn: boolean; runnerShape: 'gremion-ui' | 'tenant-store'; dnsFails: boolean }
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
    attestations: new Map(),
    knobs: { seedsOn: false, runnerShape: 'gremion-ui', dnsFails: false },
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

export function deps(w: World, catalogue = ['board', 'calendar', 'publishing', 'vault', 'votes']): ProvisioningDeps & { ledger: ReturnType<typeof memoryLedger> } {
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
        const row: ControlRow = { id: uuidv7(), slug, status: 'provisioning', realm, host }
        w.control.set(slug, row)
        m(`control:register ${slug}`)
        return row
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
      async ensure(c, { modules }) {
        const cur = w.config.get(c.slug)
        const want = [...modules].sort()
        if (cur && JSON.stringify(cur.modules) === JSON.stringify(want)) return false
        w.config.set(c.slug, { modules: want, setupComplete: cur?.setupComplete ?? false })
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
      async enable(c, moduleId, gate: EnableGate, operatorId) {
        const mine = w.enabled.get(c.id) ?? new Map()
        if (mine.has(moduleId)) return { noop: true, database: null }
        const g = await gate(c.id, moduleId)
        if (!g) throw Object.assign(new Error(`the enable gate refused (${c.id}, ${moduleId})`), { code: 'GATE_REFUSED' })
        mine.set(moduleId, { gateRefs: [g.isolationTestResultId, g.dpiaDecisionId], by: operatorId })
        w.enabled.set(c.id, mine)
        m(`pg:enable ${c.slug}/${moduleId}`)
        return { noop: false, database: `t_x__${moduleId}` }
      },
      async enabled(c) {
        return [...(w.enabled.get(c.id)?.keys() ?? [])]
      },
    },
    attestations: {
      async lookup(customerId, moduleKey) {
        return w.attestations.get(`${customerId}/${moduleKey}`)?.id ?? null
      },
      async ensure(customerId, moduleKey, operatorId, enableList) {
        const key = `${customerId}/${moduleKey}`
        const cur = w.attestations.get(key)
        if (cur) return cur.id
        const id = uuidv7()
        w.attestations.set(key, { id, operatorId, enableList: [...enableList], createdAt: new Date(Date.UTC(2026, 8, 30)) })
        m(`plt:attest ${moduleKey}`)
        return id
      },
      async list(customerId) {
        return [...w.attestations.entries()]
          .filter(([k]) => k.startsWith(`${customerId}/`))
          .map(([k, v]) => ({ moduleKey: k.split('/')[1]!, attestationId: v.id, operatorId: v.operatorId, createdAt: v.createdAt }))
      },
    },
  }
}
