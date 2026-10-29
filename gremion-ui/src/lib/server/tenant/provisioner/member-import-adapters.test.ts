// TASK-031: the member-import adapters over fakes (the SQL store itself runs
// in the scratch-stack proof, test/host/integration/member-import-proof.sh).
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { applyImport, loadVertical, planSeed, validateList, type ExistingUnit, type KindData, type SeedOp } from '@gremion/member-import'
import {
  bodiesOf,
  configWithTerms,
  IMPORT_REALM_ROLE,
  IMPORT_REQUIRED_ACTIONS,
  keycloakAccounts,
  memberImportTarget,
  seedVertical,
  type OrgStore,
  type SeedCounts,
} from './member-import-adapters'

const FILES: Record<string, unknown> = {
  'vertical.json': { schema_version: 1, id: 'demo', name: 'Demo', blueprint: 'blueprint.json', wording: 'wording.de.json', roles: 'roles.json' },
  'blueprint.json': {
    schema_version: 1,
    orgUnits: [
      { key: 'top', name: 'Top', description: null, kind: 'council', parentKey: null, visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true, childTerm: 'Teams' },
      { key: 'sub', name: 'Sub', description: null, kind: 'committee', parentKey: 'top', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true },
    ],
    seats: [{ key: 'chair', orgUnitKey: 'sub', name: 'Chair', electionMethod: 'poll', isElected: true }],
    orgSchema: [
      { key: 'council', label: 'Rat', allowedParentKinds: [], canBeRoot: true, rootMin: 1, rootMax: 1 },
      { key: 'committee', label: 'Ausschuss', allowedParentKinds: ['council'], canBeRoot: false },
    ],
  },
  'wording.de.json': { 'unit.plural': 'Gremien' },
  'roles.json': {
    schema_version: 1,
    roles: [
      { key: 'member', importable: true, membership_type: 'elected', voting: true, capabilities: ['gov.vote.cast'], withheld: [] },
      { key: 'helper', importable: true, membership_type: 'unelected', voting: false, capabilities: ['brd.card.own'], withheld: ['gov.vote.cast'] },
    ],
  },
}
const vertical = () => loadVertical((f) => JSON.stringify(FILES[f]), 'demo')

describe('keycloakAccounts (D-5)', () => {
  it('invites an imported member with UPDATE_PASSWORD ONLY, realm role member, names on create', async () => {
    const ensureInvitedUser = vi.fn(async () => ({ id: 'kc-1', created: true, invited: true }))
    const kc = { ensureInvitedUser, findUserIdByEmail: vi.fn(async () => null) }
    const r = await keycloakAccounts(kc, 'musterstadt').ensureAccount({ email: 'a@x.example', firstName: 'Anna', lastName: 'Berger', role: 'helper' })
    expect(r).toEqual({ userId: 'kc-1', created: true, invited: true })
    expect(IMPORT_REQUIRED_ACTIONS).toEqual(['UPDATE_PASSWORD'])
    expect(IMPORT_REALM_ROLE).toBe('member')
    expect(ensureInvitedUser).toHaveBeenCalledWith('musterstadt', {
      email: 'a@x.example',
      realmRole: 'member',
      requiredActions: ['UPDATE_PASSWORD'],
      firstName: 'Anna',
      lastName: 'Berger',
      skipIfHasCredential: true,
    })
  })
  it('findUserId is the read-only exact lookup', async () => {
    const findUserIdByEmail = vi.fn(async () => 'kc-9')
    const t = keycloakAccounts({ ensureInvitedUser: vi.fn(), findUserIdByEmail }, 'musterstadt')
    expect(await t.findUserId('a@x.example')).toBe('kc-9')
    expect(findUserIdByEmail).toHaveBeenCalledWith('musterstadt', 'a@x.example')
  })
})

/** An in-memory OrgStore: applySeed really applies the ops, so a rerun sees the tree. */
function memoryStore(units: ExistingUnit[]): OrgStore & { units: ExistingUnit[]; rows: string[]; members: string[]; kinds: KindData[]; seats: Array<{ orgUnitId: string; name: string }> } {
  const s = {
    units,
    rows: [] as string[],
    members: [] as string[],
    kinds: [] as KindData[],
    seats: [] as Array<{ orgUnitId: string; name: string }>,
    async listBodies() {
      return bodiesOf(s.units)
    },
    async membership() {
      return null
    },
    async addMembership(m: { bodyId: string; userId: string }) {
      s.members.push(`${m.bodyId}:${m.userId}`)
    },
    async rearm() {},
    async listUnits() {
      return s.units
    },
    async listCatalog() {
      return { kinds: s.kinds, seats: s.seats }
    },
    async applySeed(ops: readonly SeedOp[]): Promise<SeedCounts> {
      const c: SeedCounts = { units: { created: 0, adopted: 0, present: 0 }, kinds: { upserted: 0, present: 0 }, seats: { created: 0, present: 0 } }
      const ids = new Map<string, string>()
      for (const op of ops) {
        if (op.type === 'present-kind') c.kinds.present++
        else if (op.type === 'upsert-kind') {
          s.kinds = [...s.kinds.filter((k) => k.key !== op.key), op.data]
          c.kinds.upserted++
        } else if (op.type === 'present-seat') c.seats.present++
        else if (op.type === 'create-seat') {
          s.seats.push({ orgUnitId: ids.get(op.orgUnitKey)!, name: op.data.name })
          c.seats.created++
        } else if (op.type === 'present') {
          ids.set(op.key, op.id)
          c.units.present++
        } else if (op.type === 'adopt-root') {
          const u = s.units.find((x) => x.id === op.id)!
          Object.assign(u, op.patch)
          ids.set(op.key, op.id)
          c.units.adopted++
        } else {
          const id = `n${s.units.length}`
          s.units.push({ id, parentId: op.parentKey ? ids.get(op.parentKey)! : null, name: op.data.name, childTerm: op.data.childTerm, wantsMatrixRoom: op.data.wantsMatrixRoom, wantsNextcloudFolder: op.data.wantsNextcloudFolder })
          if (op.data.wantsMatrixRoom) s.rows.push(`${id}:matrix`)
          if (op.data.wantsNextcloudFolder) s.rows.push(`${id}:nextcloud`)
          ids.set(op.key, id)
          c.units.created++
        }
      }
      return c
    },
  }
  return s
}

describe('seedVertical', () => {
  const root = (): ExistingUnit => ({ id: 'r', parentId: null, name: 'Customer Body', childTerm: null, wantsMatrixRoom: false, wantsNextcloudFolder: false })

  it('adopts the root, creates the rest, merges wording; a rerun changes nothing', async () => {
    const store = memoryStore([root()])
    let config = JSON.stringify({ terms: { 'x.own': 'Mine' } })
    const ports = { store, modules: { messaging: true, files: true }, readConfig: () => config, writeConfig: (t: string) => (config = t) }
    const first = await seedVertical(vertical(), ports)
    expect(first).toEqual({
      status: 'applied',
      units: { created: 1, adopted: 1, present: 0 },
      kinds: { upserted: 2, present: 0 },
      seats: { created: 1, present: 0 },
      terms_written: true,
    })
    expect(store.kinds.map((k) => k.key)).toEqual(['council', 'committee'])
    expect(store.seats).toEqual([{ orgUnitId: 'n1', name: 'Chair' }])
    expect(store.units.find((u) => u.id === 'r')).toMatchObject({ name: 'Customer Body', childTerm: 'Teams', wantsMatrixRoom: true, wantsNextcloudFolder: true })
    expect(JSON.parse(config).terms).toEqual({ 'unit.plural': 'Gremien', 'x.own': 'Mine' })
    const second = await seedVertical(vertical(), ports)
    expect(second).toEqual({
      status: 'applied',
      units: { created: 0, adopted: 0, present: 2 },
      kinds: { upserted: 0, present: 2 },
      seats: { created: 0, present: 1 },
      terms_written: false,
    })
  })

  it('D-8 module-OFF: messaging and files off -> no matrix / nextcloud row is ever asked for', async () => {
    const store = memoryStore([root()])
    await seedVertical(vertical(), { store, modules: { messaging: false, files: false }, readConfig: () => '{}', writeConfig: () => {} })
    expect(store.rows).toEqual([])
    expect(store.units.every((u) => !u.wantsMatrixRoom && !u.wantsNextcloudFolder)).toBe(true)
  })

  it('matches the library plan (the store only applies it)', () => {
    expect(planSeed(vertical().blueprint, [root()], { messaging: false, files: false }).map((o) => o.type)).toEqual([
      'upsert-kind',
      'upsert-kind',
      'adopt-root',
      'create',
      'create-seat',
    ])
  })
})

describe('configWithTerms', () => {
  it('keeps every other key, never overrides an operator term, is a no-op when nothing is new', () => {
    const text = JSON.stringify({ brand: { product: 'P' }, terms: { a: 'own' } })
    const r = configWithTerms(text, { a: 'vertical', b: 'new' })
    expect(JSON.parse(r.text)).toEqual({ brand: { product: 'P' }, terms: { b: 'new', a: 'own' } })
    expect(configWithTerms(r.text, { a: 'vertical', b: 'new' })).toEqual({ text: r.text, changed: false })
  })
})

describe('import end-to-end over the adapters (fakes)', () => {
  it('validates against the store bodies and applies through the composed target', async () => {
    const store = memoryStore([{ id: 'r', parentId: null, name: 'Top', childTerm: null, wantsMatrixRoom: false, wantsNextcloudFolder: false }])
    const users = new Map<string, string>()
    const kc = {
      findUserIdByEmail: async (_realm: string, email: string) => users.get(email) ?? null,
      ensureInvitedUser: async (_realm: string, spec: { email: string }) => {
        const have = users.get(spec.email)
        if (have) return { id: have, created: false, invited: false }
        users.set(spec.email, `kc-${users.size + 1}`)
        return { id: users.get(spec.email)!, created: true, invited: true }
      },
    }
    const v = vertical()
    const target = memberImportTarget(keycloakAccounts(kc, 'r1'), store)
    const report = validateList('name,email,body,role\nAnna Berger,a@x.example,Top,\nBen Ho,b@x.example,Top,helper\n', { bodies: await store.listBodies(), roles: v.roles })
    const r1 = await applyImport(report, v.roles, target, report.sha256)
    expect(r1.counts).toMatchObject({ created: 2, accounts_created: 2, invites_sent: 2 })
    expect(store.members).toHaveLength(2)
  })
})

describe('source hygiene', () => {
  it('opens no database of its own (make lint-tenant-db-access) and names no vertical', () => {
    const src = readFileSync('src/lib/server/tenant/provisioner/member-import-adapters.ts', 'utf8')
    expect(src).not.toMatch(/\bpostgres\(/)
    expect(src).not.toMatch(/stura|studierend/i)
  })
})
