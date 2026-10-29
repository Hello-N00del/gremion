// services/kernel-api/src/bodies/read.ts -- the identity reads behind the HTTP
// API (TASK-080-a step c). Every query carries the customer id as a predicate
// (defence in depth over row level security; the TRD-082 recorder test holds
// them to it) and, where the read is scoped to a body, the body id too.
//
// Shapes are the spec's (camelCase, dates as YYYY-MM-DD strings, timestamps as
// ISO strings). The response contract checks them before they leave.
import type { Sql } from '@gremion/db'
import { BodiesError } from './errors.ts'
import { inCustomerTx } from './tx.ts'

export interface ReadCtx {
  sql: Sql
  customerId: string
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())

export const bodiesReads = {
  tree: (ctx: ReadCtx) =>
    inCustomerTx(ctx.sql, ctx.customerId, async (tx) => {
      const bodies = await tx<{ body_id: string; kind_key: string; name: string; short_name: string | null; parent_body_id: string | null; state: string; archived_at: Date | null; row_version: number }[]>`
        SELECT body_id, kind_key, name, short_name, parent_body_id, state, archived_at, row_version::int AS row_version
          FROM idt.body WHERE customer_id = ${ctx.customerId}::uuid ORDER BY name, body_id`
      const units = await tx<{ org_unit_id: string; body_id: string; parent_org_unit_id: string | null; kind_key: string; name: string; is_organ: boolean; state: string; row_version: number }[]>`
        SELECT u.org_unit_id, u.body_id, u.parent_org_unit_id, u.kind_key, u.name, k.is_organ, u.state, u.row_version::int AS row_version
          FROM idt.org_unit u JOIN idt.org_unit_kind k ON k.kind_key = u.kind_key AND k.level = u.kind_level AND k.customer_id = u.customer_id
         WHERE u.customer_id = ${ctx.customerId}::uuid ORDER BY u.name, u.org_unit_id`
      return {
        bodies: bodies.map((b) => ({ bodyId: b.body_id, kindKey: b.kind_key, name: b.name, shortName: b.short_name, parentBodyId: b.parent_body_id, state: b.state, archivedAt: iso(b.archived_at), rowVersion: b.row_version })),
        orgUnits: units.map((u) => ({ orgUnitId: u.org_unit_id, bodyId: u.body_id, parentOrgUnitId: u.parent_org_unit_id, kindKey: u.kind_key, name: u.name, isOrgan: u.is_organ, state: u.state, rowVersion: u.row_version })),
      }
    }),

  seats: (ctx: ReadCtx, bodyId: string) =>
    inCustomerTx(ctx.sql, ctx.customerId, async (tx) => {
      const [b] = await tx<{ body_id: string }[]>`SELECT body_id FROM idt.body WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid`
      if (!b) throw new BodiesError('NOT_FOUND', `body ${bodyId}`)
      const seats = await tx<{ seat_id: string; body_id: string; org_unit_id: string | null; title: string; seat_kind: string; fill_mode: string; holder_cardinality: string; voting: boolean; state: string }[]>`
        SELECT seat_id, body_id, org_unit_id, title, seat_kind, fill_mode, holder_cardinality, voting, state
          FROM idt.seat WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid ORDER BY title, seat_id`
      const holders = await tx<{ tenure_id: string; seat_id: string; person_id: string; starts_on: string; planned_end_on: string | null }[]>`
        SELECT tenure_id, seat_id, person_id, starts_on::text AS starts_on, planned_end_on::text AS planned_end_on
          FROM idt.tenure WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid AND ended_on IS NULL AND starts_on <= (now() AT TIME ZONE 'UTC')::date
         ORDER BY starts_on, tenure_id`
      return {
        bodyId,
        seats: seats.map((s) => ({
          seatId: s.seat_id,
          bodyId: s.body_id,
          orgUnitId: s.org_unit_id,
          title: s.title,
          seatKind: s.seat_kind,
          fillMode: s.fill_mode,
          holderCardinality: s.holder_cardinality,
          voting: s.voting,
          state: s.state,
          holders: holders.filter((h) => h.seat_id === s.seat_id).map((h) => ({ tenureId: h.tenure_id, personId: h.person_id, startsOn: h.starts_on, plannedEndOn: h.planned_end_on })),
        })),
      }
    }),

  seatTenures: (ctx: ReadCtx, seatId: string) =>
    inCustomerTx(ctx.sql, ctx.customerId, async (tx) => {
      const [s] = await tx<{ seat_id: string }[]>`SELECT seat_id FROM idt.seat WHERE customer_id = ${ctx.customerId}::uuid AND seat_id = ${seatId}::uuid`
      if (!s) throw new BodiesError('NOT_FOUND', `seat ${seatId}`)
      const rows = await tx<{ tenure_id: string; person_id: string; wahlperiode_id: string | null; starts_on: string; planned_end_on: string | null; ended_on: string | null; end_reason: string | null; source: string }[]>`
        SELECT tenure_id, person_id, wahlperiode_id, starts_on::text AS starts_on, planned_end_on::text AS planned_end_on, ended_on::text AS ended_on, end_reason, source
          FROM idt.tenure WHERE customer_id = ${ctx.customerId}::uuid AND seat_id = ${seatId}::uuid ORDER BY starts_on DESC, tenure_id DESC`
      return {
        seatId,
        tenures: rows.map((t) => ({ tenureId: t.tenure_id, personId: t.person_id, wahlperiodeId: t.wahlperiode_id, startsOn: t.starts_on, plannedEndOn: t.planned_end_on, endedOn: t.ended_on, endReason: t.end_reason, source: t.source })),
      }
    }),

  memberships: (ctx: ReadCtx, bodyId: string, asOf?: string) =>
    inCustomerTx(ctx.sql, ctx.customerId, async (tx) => {
      const [b] = await tx<{ body_id: string }[]>`SELECT body_id FROM idt.body WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid`
      if (!b) throw new BodiesError('NOT_FOUND', `body ${bodyId}`)
      const asOfDay = asOf ?? new Date().toISOString().slice(0, 10)
      const rows = await tx<{ membership_id: string; person_id: string; org_unit_id: string | null; participation_kind: string; voting: boolean; valid_from: string; valid_until: string | null; wahlperiode_id: string | null; end_reason: string | null; source: string }[]>`
        SELECT membership_id, person_id, org_unit_id, participation_kind, voting, valid_from::text AS valid_from, valid_until::text AS valid_until, wahlperiode_id, end_reason, source
          FROM idt.membership
         WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid AND valid_from <= ${asOfDay}::date AND (valid_until IS NULL OR valid_until >= ${asOfDay}::date)
         ORDER BY valid_from, membership_id`
      return {
        bodyId,
        asOf: asOfDay,
        memberships: rows.map((m) => ({
          membershipId: m.membership_id, personId: m.person_id, orgUnitId: m.org_unit_id, participationKind: m.participation_kind, voting: m.voting,
          validFrom: m.valid_from, validUntil: m.valid_until, wahlperiodeId: m.wahlperiode_id, endReason: m.end_reason, source: m.source,
        })),
      }
    }),

  /** The active person the VERIFIED subject belongs to, or null. */
  personIdOfSubject: (ctx: ReadCtx, subject: string) =>
    inCustomerTx(ctx.sql, ctx.customerId, async (tx) => {
      const [p] = await tx<{ person_id: string }[]>`
        SELECT person_id FROM idt.person WHERE customer_id = ${ctx.customerId}::uuid AND idp_subject = ${subject} AND account_state = 'active'`
      return p?.person_id ?? null
    }),

  /** The person's own record, found by the VERIFIED subject; `personId` must be that person's. Null otherwise (never says which). */
  ownPerson: (ctx: ReadCtx, personId: string, subject: string) =>
    inCustomerTx(ctx.sql, ctx.customerId, async (tx) => {
      const [p] = await tx<{ person_id: string; display_name: string | null; email: string | null; account_state: string; pseudonym: string; invited_at: Date; activated_at: Date | null }[]>`
        SELECT person_id, display_name, email, account_state, pseudonym, invited_at, activated_at
          FROM idt.person WHERE customer_id = ${ctx.customerId}::uuid AND person_id = ${personId}::uuid AND idp_subject = ${subject}`
      return p
        ? { personId: p.person_id, displayName: p.display_name, email: p.email, accountState: p.account_state, pseudonym: p.pseudonym, invitedAt: p.invited_at.toISOString(), activatedAt: iso(p.activated_at) }
        : null
    }),
}
