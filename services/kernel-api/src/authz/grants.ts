// services/kernel-api/src/authz/grants.ts — the grant service (brief s.5.4).
// Every operation is ONE transaction: authorise the granter, verify, write,
// enqueue the event. A refusal throws GrantError before any write, so a
// refused request leaves 0 rows.
//
// Granter union {person | operator}:
//  - person: a customer administrator inside their OWN tenant (R29-I7). The
//    RLS context is the request's resolved customer, so a subject or body of
//    another customer is simply not found (0 rows). granter_kind='person',
//    granted_by = the verified token subject's person, source='customer_admin'.
//    TRD-091: the role the request names (granterRole) must be a role the
//    granter VERIFIABLY holds (a live role grant read here, never trusted from
//    the body) and the PDP must allow idt.grant.manage in the body.
//    TRD-090: a privileged grant needs a fresh step-up in the claims.
//  - operator: granter_kind='operator', source='control_panel'. No HTTP caller
//    at P1 (lane note C4): exercised through the service layer only.
// A self-grant is always refused (FLOW-IDN-003 self-escalation).
import { capabilityDef, isPrivilegedCapability, isPrivilegedRole, roleDef, roleIncludes } from './catalogue.ts'
import { GrantError } from './errors.ts'
import { emitGrantEvent, type GrantRow } from './events.ts'
import { customerWideGrantRoles, decideInTx, type EnabledModules } from './pdp.ts'
import { checkStepUp } from './stepup.ts'
import { assertUuid, inCustomerTx, UUID, type Sql } from './tx.ts'
import { uuidv7 } from './uuid.ts'

export type Granter = { kind: 'person'; claims: Record<string, unknown> } | { kind: 'operator'; operatorId: string }

export interface GrantDeps {
  enabledModules: EnabledModules
  /** seconds since epoch; tests inject it, production uses the wall clock */
  nowSeconds?: () => number
}

export interface IssueRequest {
  bodyId: string
  subjectPersonId: string
  grantKind: 'role' | 'capability'
  key: string
  /** the role the granter says they act under (TRD-091); person granters only */
  granterRole?: string
  resource?: { kind: string; id: string }
  validFrom?: string
  validUntil?: string | null
  /** 'meeting_role' etc. are system sources; HTTP callers get customer_admin / control_panel only */
  source?: 'customer_admin' | 'control_panel' | 'meeting_role'
}

const now = (d: GrantDeps) => (d.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()

interface Actor {
  kind: 'person' | 'operator'
  id: string
}

async function personBySub(tx: Sql, claims: Record<string, unknown>): Promise<string> {
  const sub = claims.sub
  if (typeof sub !== 'string' || !sub) throw new GrantError('forbidden', 'the token carries no subject')
  const rows = await tx<{ person_id: string }[]>`SELECT person_id::text FROM idt.person WHERE idp_subject = ${sub} AND account_state = 'active'`
  const p = rows[0]
  if (!p) throw new GrantError('forbidden', 'the token subject is not an active person of this customer')
  return p.person_id
}

function requireStepUp(g: Granter, deps: GrantDeps): void {
  if (g.kind !== 'person') return
  const v = checkStepUp(g.claims, now(deps))
  if (!v.ok) throw new GrantError('insufficient_user_authentication', `a fresh step-up is required (${v.reason})`)
}

/** The granter must be allowed to administer grants in this body (PDP idt.grant.manage); operators always are. */
async function authoriseManager(tx: Sql, deps: GrantDeps, customerId: string, granter: Granter, bodyId: string): Promise<Actor> {
  if (granter.kind === 'operator') {
    assertUuid(granter.operatorId, 'operatorId')
    return { kind: 'operator', id: granter.operatorId }
  }
  const personId = await personBySub(tx, granter.claims)
  const d = await decideInTx(tx, deps.enabledModules, { customerId, subject: { personId }, bodyId, capability: 'idt.grant.manage' })
  if (!d.allow) {
    // a customer-level role held in the verwaltung administers grants in every body of this customer (decision 2026-10-22)
    const wide = d.reason === 'no_grant' ? await customerWideGrantRoles(tx, personId) : []
    if (wide.length === 0) throw new GrantError('forbidden', `granting is not allowed in this body (${d.reason})`)
  }
  return { kind: 'person', id: personId }
}

/** TRD-091: the claimed role must be one the SERVER verifies the granter holds, live, in this body, or a customer-level role held in the verwaltung. */
async function verifyGranterRole(tx: Sql, personId: string, bodyId: string, granterRole: string | undefined): Promise<void> {
  if (!granterRole) throw new GrantError('bad_request', 'granterRole is required')
  if ((await customerWideGrantRoles(tx, personId)).includes(granterRole)) return
  const held = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM idt.authz_grant g
     WHERE g.subject_person_id = ${personId}::uuid AND g.body_id = ${bodyId}::uuid AND g.grant_kind = 'role' AND g.role_key = ${granterRole}
       AND g.state IN ('active', 'scheduled') AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())`
  if ((held[0]?.n ?? 0) === 0) throw new GrantError('granter_role_mismatch', 'the named granter role is not a role the granter holds in this body')
}

export async function issueGrant(sql: Sql, deps: GrantDeps, customerId: string, granter: Granter, req: IssueRequest): Promise<GrantRow> {
  assertUuid(req.bodyId, 'bodyId')
  assertUuid(req.subjectPersonId, 'subjectPersonId')
  if (req.grantKind !== 'role' && req.grantKind !== 'capability') throw new GrantError('bad_request', 'grantKind must be role or capability')
  if (typeof req.key !== 'string' || req.key.startsWith('platform.')) throw new GrantError('platform_level', 'platform-level roles and capabilities are never granted by a customer')
  const privileged = req.grantKind === 'role' ? isPrivilegedRole(req.key) : isPrivilegedCapability(req.key)
  if (req.grantKind === 'role' ? !roleDef(req.key) : !capabilityDef(req.key)) throw new GrantError('unknown_key', `${req.grantKind} ${req.key} is not in the catalogue`)
  const source = req.source ?? (granter.kind === 'operator' ? 'control_panel' : 'customer_admin')
  if (granter.kind === 'person' && source !== 'customer_admin') throw new GrantError('forbidden', 'a person grants with source customer_admin only')
  if (granter.kind === 'operator' && source !== 'control_panel' && source !== 'meeting_role') throw new GrantError('forbidden', 'an operator grants with source control_panel only')
  if (req.validUntil !== undefined && req.validUntil !== null && (typeof req.validUntil !== 'string' || Number.isNaN(Date.parse(req.validUntil)))) throw new GrantError('bad_request', 'validUntil is not a timestamp')
  if (req.resource !== undefined) {
    if (typeof req.resource.kind !== 'string' || req.resource.kind === '') throw new GrantError('bad_request', 'resource.kind is required')
    if (typeof req.resource.id !== 'string' || !UUID.test(req.resource.id)) throw new GrantError('bad_request', 'resource.id is not a uuid')
  }
  const validFromMs = req.validFrom ? Date.parse(req.validFrom) : now(deps) * 1000
  if (Number.isNaN(validFromMs)) throw new GrantError('bad_request', 'validFrom is not a timestamp')
  return inCustomerTx(sql, customerId, async (tx) => {
    const actor = await authoriseManager(tx, deps, customerId, granter, req.bodyId)
    if (actor.kind === 'person') {
      await verifyGranterRole(tx, actor.id, req.bodyId, req.granterRole)
      // TRD-113/TRD-091: holding the role is not enough; it must include what is granted
      if (!roleIncludes(req.granterRole!, req.grantKind, req.key)) throw new GrantError('granter_role_mismatch', `the granter role does not include ${req.grantKind} ${req.key}`)
    }
    if (actor.kind === 'person' && actor.id === req.subjectPersonId) throw new GrantError('self_grant', 'a person never grants themselves')
    if (privileged) requireStepUp(granter, deps)
    const person = await tx`SELECT 1 FROM idt.person WHERE person_id = ${req.subjectPersonId}::uuid AND account_state = 'active'`
    if (person.length === 0) throw new GrantError('unknown_subject', 'no such person in this customer')
    const body = await tx<{ kind_key: string }[]>`SELECT kind_key FROM idt.body WHERE body_id = ${req.bodyId}::uuid`
    if (body.length === 0) throw new GrantError('unknown_body', 'no such body in this customer')
    if (req.grantKind === 'capability') {
      const def = capabilityDef(req.key)!
      if (def.moduleKey !== null && !(await deps.enabledModules(customerId)).has(def.moduleKey)) {
        throw new GrantError('module_not_enabled', `module ${def.moduleKey} is not enabled for this customer`)
      }
    } else {
      const scope = roleDef(req.key)!.scopeLevel
      const inVerwaltung = body[0]!.kind_key === 'verwaltung'
      if (scope === 'customer' && !inVerwaltung) throw new GrantError('role_scope', 'customer-level roles are granted in the verwaltung body only')
      if (scope === 'body' && inVerwaltung) throw new GrantError('role_scope', 'body-level roles are granted outside the verwaltung only')
    }
    const live = await tx`SELECT 1 FROM idt.${tx.unsafe(req.grantKind === 'role' ? 'role' : 'capability')} WHERE ${tx.unsafe(req.grantKind === 'role' ? 'role_key' : 'capability_key')} = ${req.key} AND ${tx.unsafe(req.grantKind === 'role' ? "state = 'active'" : "state = 'available'")}`
    if (live.length === 0) throw new GrantError('unknown_key', `${req.key} is not available in this customer (run authz sync)`)
    const state = validFromMs > now(deps) * 1000 ? 'scheduled' : 'active'
    const id = uuidv7()
    const kind = actor.kind
    let row: GrantRow
    try {
      const rows = await tx<GrantRow[]>`
        INSERT INTO idt.authz_grant (grant_id, customer_id, body_id, subject_person_id, grant_kind, role_key, capability_key, resource_kind, resource_id,
          valid_from, valid_until, granter_kind, granted_by, source, state, created_by_kind, created_by, updated_by_kind, updated_by)
        VALUES (${id}::uuid, ${customerId}::uuid, ${req.bodyId}::uuid, ${req.subjectPersonId}::uuid, ${req.grantKind},
          ${req.grantKind === 'role' ? req.key : null}, ${req.grantKind === 'capability' ? req.key : null},
          ${req.resource?.kind ?? null}, ${req.resource?.id ?? null}::uuid, ${new Date(validFromMs).toISOString()}::timestamptz, ${req.validUntil ?? null}::timestamptz,
          ${kind}, ${actor.id}::uuid, ${source}, ${state}, ${kind}, ${actor.id}::uuid, ${kind}, ${actor.id}::uuid)
        RETURNING grant_id::text, body_id::text, subject_person_id::text, grant_kind, role_key, capability_key, resource_kind, resource_id::text, valid_from, valid_until,
                  granter_kind, granted_by::text, source, state, revoked_at, revoke_reason, row_version`
      row = rows[0]!
    } catch (e) {
      if ((e as { code?: string }).code === '23514') throw new GrantError('constraint', (e as Error).message)
      throw e
    }
    await emitGrantEvent(tx, 'granted', row)
    return row
  })
}

const GRANT_COLS = `grant_id::text, body_id::text, subject_person_id::text, grant_kind, role_key, capability_key, resource_kind, resource_id::text, valid_from, valid_until,
                  granter_kind, granted_by::text, source, state, revoked_at, revoke_reason, row_version`

async function closeRows(tx: Sql, ids: string[], revoker: Actor | null, reason: string): Promise<GrantRow[]> {
  if (ids.length === 0) return []
  const kind = revoker?.kind ?? 'system'
  const by = revoker?.id ?? null
  return tx.unsafe<GrantRow[]>(
    `UPDATE idt.authz_grant SET state = 'revoked', revoked_at = now(), revoked_by_kind = $2, revoked_by = $3::uuid, revoke_reason = $4,
            updated_by_kind = $2, updated_by = $3::uuid
      WHERE grant_id = ANY ($1::uuid[]) AND state IN ('scheduled', 'active') RETURNING ${GRANT_COLS}`,
    [ids, kind, by, reason] as never[],
  )
}

export async function revokeGrant(sql: Sql, deps: GrantDeps, customerId: string, revoker: Granter, grantId: string): Promise<GrantRow> {
  assertUuid(grantId, 'grantId')
  return inCustomerTx(sql, customerId, async (tx) => {
    const cur = await tx<{ body_id: string; role_key: string | null; capability_key: string | null; state: string }[]>`
      SELECT body_id::text, role_key, capability_key, state FROM idt.authz_grant WHERE grant_id = ${grantId}::uuid`
    const g = cur[0]
    if (!g) throw new GrantError('not_open', 'no such grant in this customer')
    const who = await authoriseManager(tx, deps, customerId, revoker, g.body_id)
    const privileged = g.role_key ? isPrivilegedRole(g.role_key) : g.capability_key ? isPrivilegedCapability(g.capability_key) : false
    if (privileged) requireStepUp(revoker, deps)
    const rows = await closeRows(tx, [grantId], who, 'manual')
    const row = rows[0]
    if (!row) throw new GrantError('not_open', 'the grant is already closed')
    await emitGrantEvent(tx, 'revoked', row)
    return row
  })
}

/** PRD-IDN-002: revoke every open grant of a person in one step-up window; one revoked event per grant. */
export async function revokeAllForPerson(sql: Sql, deps: GrantDeps, customerId: string, revoker: Granter, personId: string): Promise<GrantRow[]> {
  assertUuid(personId, 'personId')
  requireStepUp(revoker, deps)
  return inCustomerTx(sql, customerId, async (tx) => {
    const open = await tx<{ grant_id: string; body_id: string }[]>`
      SELECT grant_id::text, body_id::text FROM idt.authz_grant WHERE subject_person_id = ${personId}::uuid AND state IN ('scheduled', 'active') ORDER BY grant_id`
    let who: Actor | null = null
    for (const bodyId of new Set(open.map((o) => o.body_id))) who = await authoriseManager(tx, deps, customerId, revoker, bodyId)
    who ??= revoker.kind === 'operator' ? { kind: 'operator', id: revoker.operatorId } : { kind: 'person', id: await personBySub(tx, revoker.claims) }
    const rows = await closeRows(tx, open.map((o) => o.grant_id), who, 'manual')
    for (const r of rows) await emitGrantEvent(tx, 'revoked', r)
    return rows
  })
}

/** May this person read the grants of `bodyId`? PDP idt.grant.read in the body, or a customer-level role held in the verwaltung (decision 2026-10-22, same authority as granting). */
export async function mayReadGrants(sql: Sql, deps: GrantDeps, customerId: string, claims: Record<string, unknown>, bodyId: string): Promise<{ allow: boolean; reason: string }> {
  return inCustomerTx(sql, customerId, async (tx) => {
    const personId = await personBySub(tx, claims)
    const d = await decideInTx(tx, deps.enabledModules, { customerId, subject: { personId }, bodyId, capability: 'idt.grant.read' })
    if (d.allow) return { allow: true, reason: d.reason }
    if (d.reason === 'no_grant' && (await customerWideGrantRoles(tx, personId)).length > 0) return { allow: true, reason: 'customer_wide' }
    return { allow: false, reason: d.reason }
  })
}

export async function listGrants(sql: Sql, customerId: string, filter: { bodyId?: string; personId?: string } = {}): Promise<GrantRow[]> {
  return inCustomerTx(sql, customerId, (tx) =>
    tx.unsafe<GrantRow[]>(
      `SELECT ${GRANT_COLS} FROM idt.authz_grant WHERE ($1::uuid IS NULL OR body_id = $1::uuid) AND ($2::uuid IS NULL OR subject_person_id = $2::uuid) ORDER BY grant_id`,
      [filter.bodyId ?? null, filter.personId ?? null] as never[],
    ),
  )
}

