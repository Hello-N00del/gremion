// src/lib/server/governance/org-units-db.ts
//
// WP-Write Task 21: createOrgUnit / updateOrgUnit / deleteOrgUnit / getOrgUnit
// now accept an optional first-arg PgTransaction so a sub-org write
// service can pair org_unit + finance_unit changes atomically. Reads keep
// the old single-arg signature for the 38 existing callers; the three
// writes carry a second overload with `tx` as the leading parameter,
// matching the finance reference repo (finance-unit-db.ts).
//
// P0.3a: the atomic provisioning enqueue (org_unit INSERT + provisioning_resources
// 'pending' rows in one BEGIN/COMMIT) lives at the three creator ROUTES, not
// here. The ONE side effect these writes carry is the org-unit EVENT outbox row
// (org_unit_event_outbox, see ./org-unit-event-outbox): createOrgUnit /
// updateOrgUnit / deleteOrgUnit enqueue it on the SAME runner as the org_units
// DML, so the two always commit or roll back together. With a caller-supplied tx
// that is the caller's transaction; the pool overloads open their own (see
// withWriteTx), so a failed enqueue never leaves a committed write with no event.
// It is a no-op when NATS_URL is unset. The relay (./register.server) publishes it
// so the finance org_unit_mirror stays in sync.
import { getDb } from '../db'
import { getRunner as genericGetRunner, unpackTxArgs, type PgTransaction, type SqlRunner } from '$lib/server/db/tx'
import { loadOrgSchema, type OrgSchema } from './org-schema'
import { enqueueOrgUnitEvent, type OrgUnitEventInput } from './org-unit-event-outbox'

/** Governance-pool-defaulting runner (was reverse-imported from finance, P0.1).
 *  getDb is passed as a factory to preserve the lazy `tx ?? pool()` short-circuit. */
const getRunner = (tx: PgTransaction | undefined) => genericGetRunner(tx, getDb)

/** Run an org_units write together with its event outbox row. With a caller tx the
 *  body runs on it (co-commits with the caller's other work). Without one the pool
 *  overloads must not run the DML and the enqueue as two autocommit statements - a
 *  failed enqueue would leave a committed change and no outbox row for anything
 *  downstream to detect - so the body runs on a transaction of its own. */
async function withWriteTx<T>(
  tx: PgTransaction | undefined,
  body: (sql: SqlRunner) => Promise<T>
): Promise<T> {
  if (tx) return body(tx)
  return (await getDb().begin((own) => body(own))) as T
}

/** Tenant kind key — per-tenant catalog, no longer a closed union (P2.2). */
export type OrgUnitKind = string
export type MembershipType = 'elected' | 'unelected' | 'employee'

export interface OrgUnit {
  readonly id: string
  readonly parent_id: string | null
  readonly kind: OrgUnitKind
  readonly name: string
  readonly description: string | null
  readonly child_term: string | null
  /** P2.2 (#202, D-KL): per-unit display-label override; NULL → catalog label. */
  readonly kind_label: string | null
  /** P2.2 (#202, §3.5(d)): beratend vs beschließend. */
  readonly authority: 'advisory' | 'deciding'
  readonly visibility: 'all_members' | 'committee_only'
  readonly wants_matrix_room: boolean
  readonly wants_nextcloud_folder: boolean
  readonly created_at: Date
}

export interface OrgUnitMember {
  readonly id: string
  readonly org_unit_id: string
  readonly user_keycloak_id: string
  readonly membership_type: MembershipType
  readonly term_start: Date | null
  readonly term_end: Date | null
  /** P2.2 (#202, §3.5(d)): sachkundige Bürger sit without a vote. */
  readonly voting: boolean
  readonly joined_at: Date
}

export async function listOrgUnits(): Promise<readonly OrgUnit[]> {
  return getDb()<OrgUnit[]>`SELECT * FROM org_units ORDER BY name`
}

export async function getOrgUnit(id: string): Promise<OrgUnit | null>
export async function getOrgUnit(tx: PgTransaction, id: string): Promise<OrgUnit | null>
export async function getOrgUnit(
  txOrId: PgTransaction | string, maybeId?: string
): Promise<OrgUnit | null> {
  const tx = typeof txOrId === 'function' ? (txOrId as PgTransaction) : undefined
  const id = typeof txOrId === 'function' ? (maybeId as string) : (txOrId as string)
  const sql = getRunner(tx)
  const rows = await sql<OrgUnit[]>`SELECT * FROM org_units WHERE id = ${id}`
  return rows[0] ?? null
}

export async function getChildOrgUnits(parentId: string): Promise<readonly OrgUnit[]> {
  return getDb()<OrgUnit[]>`SELECT * FROM org_units WHERE parent_id = ${parentId} ORDER BY name`
}

/** The 'upserted' event for an org_units row: the snapshot the finance mirror needs. */
function upsertedEvent(u: Pick<OrgUnit, 'id' | 'name' | 'kind' | 'parent_id'>): OrgUnitEventInput {
  return {
    eventType: 'upserted',
    aggregateId: u.id,
    payload: { id: u.id, name: u.name, kind: u.kind, parent_id: u.parent_id },
  }
}

export interface CreateOrgUnitInput {
  name: string
  description: string | null
  parentId: string | null
  kind: OrgUnitKind
  visibility: 'all_members' | 'committee_only'
  wantsMatrixRoom: boolean
  wantsNextcloudFolder: boolean
  // WI-3: optional so the 40+ existing callers compile unchanged; only the
  // seeder and the tree-admin endpoint set a real value. Defaults to NULL.
  childTerm?: string | null
  // P2.2 (#202, D-KL): per-unit display-label override; NULL → catalog label.
  kindLabel?: string | null
  // P2.2 (#202, §3.5(d)): beratend vs beschließend; defaults to 'deciding'.
  authority?: 'advisory' | 'deciding'
}

export async function createOrgUnit(data: CreateOrgUnitInput): Promise<OrgUnit>
export async function createOrgUnit(tx: PgTransaction, data: CreateOrgUnitInput): Promise<OrgUnit>
export async function createOrgUnit(
  txOrData: PgTransaction | CreateOrgUnitInput, maybeData?: CreateOrgUnitInput
): Promise<OrgUnit> {
  const { tx, data } = unpackTxArgs<CreateOrgUnitInput>(txOrData, maybeData)
  // Both overloads: INSERT (+ the co-committed event outbox row). Atomicity of
  // INSERT + enqueueResources in one BEGIN/COMMIT is the responsibility of each
  // creator route, not this DB helper.
  return withWriteTx(tx, async (sql) => {
    const rows = await sql<OrgUnit[]>`
      INSERT INTO org_units
        (name, description, parent_id, kind, visibility, wants_matrix_room, wants_nextcloud_folder, child_term, kind_label, authority)
      VALUES
        (${data.name}, ${data.description}, ${data.parentId}, ${data.kind},
         ${data.visibility}, ${data.wantsMatrixRoom}, ${data.wantsNextcloudFolder}, ${data.childTerm ?? null},
         ${data.kindLabel ?? null}, ${data.authority ?? 'deciding'})
      RETURNING *`
    const created = rows[0]!
    // Same runner as the INSERT: the mirror-resync event co-commits (no-op without NATS_URL).
    await enqueueOrgUnitEvent(sql, upsertedEvent(created))
    return created
  })
}

export interface UpdateOrgUnitPatch {
  name?: string
  description?: string | null
  visibility?: 'all_members' | 'committee_only'
  childTerm?: string | null
}

export async function updateOrgUnit(id: string, data: UpdateOrgUnitPatch): Promise<OrgUnit | null>
export async function updateOrgUnit(tx: PgTransaction, id: string, data: UpdateOrgUnitPatch): Promise<OrgUnit | null>
export async function updateOrgUnit(
  txOrId: PgTransaction | string,
  idOrData: string | UpdateOrgUnitPatch,
  maybeData?: UpdateOrgUnitPatch
): Promise<OrgUnit | null> {
  let tx: PgTransaction | undefined
  let id: string
  let data: UpdateOrgUnitPatch
  if (typeof txOrId === 'function') {
    tx = txOrId as PgTransaction
    id = idOrData as string
    data = maybeData as UpdateOrgUnitPatch
  } else {
    id = txOrId as string
    data = idOrData as UpdateOrgUnitPatch
  }
  return withWriteTx(tx, async (sql) => {
    const rows = await sql<OrgUnit[]>`
      UPDATE org_units SET
        name = COALESCE(${data.name ?? null}, name),
        description = ${data.description !== undefined ? data.description : sql`description`},
        child_term = ${data.childTerm !== undefined ? data.childTerm : sql`child_term`},
        visibility = COALESCE(${data.visibility ?? null}, visibility)
      WHERE id = ${id}
      RETURNING *`
    const updated = rows[0] ?? null
    // The fresh snapshot, only when a row matched (no-op without NATS_URL).
    if (updated !== null) await enqueueOrgUnitEvent(sql, upsertedEvent(updated))
    return updated
  })
}

/** FLOW-MSG-001 (TASK-009 lane B): flips one subsystem's `wants_*` flag. Always called
 *  inside the caller's tx — attachSubsystem/releaseSubsystem co-commit this with the
 *  ledger enqueue/detach so the flag and the row never drift apart. `UpdateOrgUnitPatch`
 *  intentionally does not carry `wants_*` (it is a request-shaped patch; this is an
 *  internal provisioning primitive), so this stays a standalone function. Only two
 *  literal branches — no dynamic identifier building, no injection surface. */
export async function setSubsystemWanted(
  tx: PgTransaction, id: string, subsystem: 'matrix' | 'nextcloud', wanted: boolean
): Promise<void> {
  if (subsystem === 'matrix') {
    await tx`UPDATE org_units SET wants_matrix_room = ${wanted} WHERE id = ${id}`
  } else {
    await tx`UPDATE org_units SET wants_nextcloud_folder = ${wanted} WHERE id = ${id}`
  }
}

export async function deleteOrgUnit(id: string): Promise<void>
export async function deleteOrgUnit(tx: PgTransaction, id: string): Promise<void>
export async function deleteOrgUnit(
  txOrId: PgTransaction | string, maybeId?: string
): Promise<void> {
  const tx = typeof txOrId === 'function' ? (txOrId as PgTransaction) : undefined
  const id = typeof txOrId === 'function' ? (maybeId as string) : (txOrId as string)
  await withWriteTx(tx, async (sql) => {
    const deleted = await sql<{ id: string }[]>`DELETE FROM org_units WHERE id = ${id} RETURNING id`
    // The tombstone, only when a row was actually deleted (no-op without NATS_URL).
    if (deleted.length > 0) {
      await enqueueOrgUnitEvent(sql, { eventType: 'deleted', aggregateId: id, payload: { id } })
    }
  })
}

export async function listOrgUnitMembers(orgUnitId: string): Promise<readonly OrgUnitMember[]> {
  return getDb()<OrgUnitMember[]>`
    SELECT * FROM org_unit_members WHERE org_unit_id = ${orgUnitId} ORDER BY joined_at`
}

export interface AddOrgUnitMemberData {
  orgUnitId: string
  userKeycloakId: string
  membershipType: MembershipType
  termStart: string | null
  termEnd: string | null
  /** P2.2 (#202, §3.5(d)): sachkundige Bürger sit without a vote; defaults to true. */
  voting?: boolean
}

export async function addOrgUnitMember(data: AddOrgUnitMemberData): Promise<OrgUnitMember>
export async function addOrgUnitMember(tx: PgTransaction, data: AddOrgUnitMemberData): Promise<OrgUnitMember>
export async function addOrgUnitMember(
  txOrData: PgTransaction | AddOrgUnitMemberData, maybeData?: AddOrgUnitMemberData
): Promise<OrgUnitMember> {
  const { tx, data } = unpackTxArgs<AddOrgUnitMemberData>(txOrData, maybeData)
  // On conflict, only overwrite `voting` when the caller explicitly provided
  // it — the runtime mutation paths (orchestrator addMember, members POST,
  // groups POST) omit `voting`, and a blanket EXCLUDED.voting would silently
  // reset a seeded voting=false (sachkundiger Bürger) to true on every
  // membership update. Fresh inserts still default to true.
  const votingProvided = data.voting !== undefined
  const sql = getRunner(tx)
  const rows = await sql<OrgUnitMember[]>`
    INSERT INTO org_unit_members
      (org_unit_id, user_keycloak_id, membership_type, term_start, term_end, voting)
    VALUES
      (${data.orgUnitId}, ${data.userKeycloakId}, ${data.membershipType},
       ${data.termStart}, ${data.termEnd}, ${data.voting ?? true})
    ON CONFLICT (org_unit_id, user_keycloak_id) DO UPDATE SET
      membership_type = EXCLUDED.membership_type,
      term_start = EXCLUDED.term_start,
      term_end = EXCLUDED.term_end,
      voting = CASE WHEN ${votingProvided} THEN EXCLUDED.voting ELSE org_unit_members.voting END
    RETURNING *`
  return rows[0]!
}

/**
 * TASK-031 (the member import): insert a membership, or do NOTHING when the
 * (org unit, user) pair already exists - an existing row's membership type,
 * term and voting flag are never overwritten (addOrgUnitMember's upsert is for
 * the UI paths that mean to change them). True when a row was inserted.
 */
export async function addOrgUnitMemberIfAbsent(data: AddOrgUnitMemberData): Promise<boolean>
export async function addOrgUnitMemberIfAbsent(tx: PgTransaction, data: AddOrgUnitMemberData): Promise<boolean>
export async function addOrgUnitMemberIfAbsent(
  txOrData: PgTransaction | AddOrgUnitMemberData, maybeData?: AddOrgUnitMemberData
): Promise<boolean> {
  const { tx, data } = unpackTxArgs<AddOrgUnitMemberData>(txOrData, maybeData)
  const rows = await getRunner(tx)<Array<{ id: string }>>`
    INSERT INTO org_unit_members
      (org_unit_id, user_keycloak_id, membership_type, term_start, term_end, voting)
    VALUES
      (${data.orgUnitId}, ${data.userKeycloakId}, ${data.membershipType},
       ${data.termStart}, ${data.termEnd}, ${data.voting ?? true})
    ON CONFLICT (org_unit_id, user_keycloak_id) DO NOTHING
    RETURNING id`
  return rows.length > 0
}

export async function removeOrgUnitMember(orgUnitId: string, userKeycloakId: string): Promise<void>
export async function removeOrgUnitMember(tx: PgTransaction, orgUnitId: string, userKeycloakId: string): Promise<void>
export async function removeOrgUnitMember(
  txOrOrgUnitId: PgTransaction | string, orgUnitIdOrUserKeycloakId: string, maybeUserKeycloakId?: string
): Promise<void> {
  const tx = typeof txOrOrgUnitId === 'function' ? (txOrOrgUnitId as PgTransaction) : undefined
  const orgUnitId = typeof txOrOrgUnitId === 'function' ? (orgUnitIdOrUserKeycloakId as string) : (txOrOrgUnitId as string)
  const userKeycloakId = typeof txOrOrgUnitId === 'function' ? (maybeUserKeycloakId as string) : (orgUnitIdOrUserKeycloakId as string)
  const sql = getRunner(tx)
  await sql`
    DELETE FROM org_unit_members
    WHERE org_unit_id = ${orgUnitId} AND user_keycloak_id = ${userKeycloakId}`
}

export async function isMemberOf(orgUnitId: string, userKeycloakId: string): Promise<boolean> {
  const rows = await getDb()`
    SELECT 1 FROM org_unit_members
    WHERE org_unit_id = ${orgUnitId} AND user_keycloak_id = ${userKeycloakId} LIMIT 1`
  return rows.length > 0
}

export async function hasMembers(orgUnitId: string): Promise<boolean> {
  const rows = await getDb()`SELECT 1 FROM org_unit_members WHERE org_unit_id = ${orgUnitId} LIMIT 1`
  return rows.length > 0
}

export async function hasElections(orgUnitId: string): Promise<boolean> {
  const rows = await getDb()`SELECT 1 FROM committee_elections WHERE org_unit_id = ${orgUnitId} LIMIT 1`
  return rows.length > 0
}

export async function hasProtocols(orgUnitId: string): Promise<boolean> {
  const rows = await getDb()`SELECT 1 FROM protocols WHERE committee_id = ${orgUnitId} LIMIT 1`
  return rows.length > 0
}

export async function getOrgUnitIdsForUser(userKeycloakId: string): Promise<readonly string[]> {
  const rows = await getDb()<Array<{ org_unit_id: string }>>`
    SELECT org_unit_id FROM org_unit_members WHERE user_keycloak_id = ${userKeycloakId}`
  return rows.map((r) => r.org_unit_id)
}

export async function getMemberCounts(): Promise<ReadonlyMap<string, number>> {
  const rows = await getDb()<Array<{ org_unit_id: string; count: string }>>`
    SELECT org_unit_id, COUNT(*)::text AS count FROM org_unit_members GROUP BY org_unit_id`
  return new Map(rows.map((r) => [r.org_unit_id, Number(r.count)]))
}

// ── Gremien tree (WI-3, labels per-tenant since P2.2) ───────────────────
// A nested DTO over the org_units forest, built from the existing
// listOrgUnits() + getMemberCounts() reads plus the tenant kind catalog
// (loadOrgSchema). Mirrors the v6 contracts.jsx §3 orgTree() shape.
export interface OrgTreeNode {
  readonly ou: OrgUnit
  readonly kind_friendly: string
  readonly child_term: string | null
  readonly member_count: number
  readonly rollup_count: number
  readonly children: OrgTreeNode[]
}

// Pure tree assembly (P2.2, #202): labels come from the per-unit kind_label
// override or the tenant kind catalog — the retired name-sniffing helper
// pair is dead (D-KL). Rollup math is UNCHANGED (the §6-P2.2
// no-double-count guarantee). Extracted from buildOrgTree for unit-testability.
export function assembleOrgTree(
  units: readonly OrgUnit[],
  counts: ReadonlyMap<string, number>,
  schema: OrgSchema
): OrgTreeNode[] {
  const build = (parentId: string | null): OrgTreeNode[] =>
    units
      .filter((o) => o.parent_id === parentId)
      .map((o) => {
        const children = build(o.id)
        const direct = counts.get(o.id) ?? 0
        const rollup = direct + children.reduce((s, c) => s + c.rollup_count, 0)
        const catalog = schema.kinds[o.kind]
        return {
          ou: o,
          kind_friendly: o.kind_label ?? catalog?.label ?? o.kind,
          // ou.child_term wins when non-empty — '' falls through to the
          // catalog default exactly like NULL (pins the old childTermFor
          // truthiness; '' rows are reachable via the child-term PATCH).
          // Else the catalog childTerm when children exist; null for leaves.
          child_term:
            children.length === 0 ? null : (o.child_term || (catalog?.childTerm ?? null)),
          member_count: direct,
          rollup_count: rollup,
          children,
        }
      })
  return build(null)
}

export async function buildOrgTree(): Promise<OrgTreeNode[]> {
  const [units, counts, schema] = await Promise.all([
    listOrgUnits(),
    getMemberCounts(),
    loadOrgSchema(),
  ])
  return assembleOrgTree(units, counts, schema)
}

// ── namespaced surface (consumer-facing) ────────────────────────────────
// Mirrors financeUnitDb / subOrgTypesDb. New code can dispatch through this
// object; the 38 existing direct-function callers stay untouched.
export const orgUnitsDb = {
  list: listOrgUnits,
  getById: getOrgUnit,
  getChildren: getChildOrgUnits,
  insert: createOrgUnit,
  update: updateOrgUnit,
  delete: deleteOrgUnit,
  listMembers: listOrgUnitMembers,
  addMember: addOrgUnitMember,
  removeMember: removeOrgUnitMember,
  isMemberOf,
  hasMembers,
  hasElections,
  hasProtocols,
  getIdsForUser: getOrgUnitIdsForUser,
  getMemberCounts,
  buildTree: buildOrgTree
} as const
