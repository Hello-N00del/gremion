// services/kernel-api/src/bodies/people.ts -- persons, memberships, tenures
// (see core.ts for the rules every operation obeys).
import { randomBytes } from 'node:crypto'
import { BodiesError } from './errors.ts'
import { by, expectVersion, one, type Core, type OpCtx, type Written } from './core.ts'

export type ParticipationKind = 'elected_member' | 'non_voting_helper' | 'employee' | 'initiative_member' | 'initiative_lead'
export type MembershipSource = 'admin' | 'control_panel' | 'import' | 'provisioning'
export type TenureSource = 'election' | 'delegation' | 'appointment' | 'succession'

export function peopleOps(c: Core) {
  const personState = async (tx: Parameters<Parameters<Core['run']>[1]>[0], personId: string): Promise<string> =>
    one(await tx<{ account_state: string }[]>`SELECT account_state FROM idt.person WHERE person_id = ${personId}::uuid FOR UPDATE`, `person ${personId}`).account_state

  return {
    // -------------------------------------------------------------- persons
    invitePerson: (ctx: OpCtx, i: { email: string; displayName: string }): Promise<Written & { personId: string }> =>
      c.run(ctx, async (tx) => {
        await c.allow(ctx, 'person.invite', null)
        const a = by(ctx.actor)
        const pseudonym = `p_${randomBytes(12).toString('hex')}`
        const r = one(
          await tx<{ person_id: string; row_version: number }[]>`
            INSERT INTO idt.person (customer_id, display_name, email, pseudonym, created_by_kind, created_by, updated_by_kind, updated_by)
            VALUES (${ctx.customerId}::uuid, ${i.displayName}, ${i.email}, ${pseudonym}, ${a.kind}, ${a.id}, ${a.kind}, ${a.id})
            RETURNING person_id, row_version::int AS row_version`,
          'person insert',
        )
        await c.emit(tx, ctx, 'person.invited', r.row_version, r.person_id, { person_id: r.person_id, customer_id: ctx.customerId })
        return { personId: r.person_id, rowVersion: r.row_version }
      }),

    activatePerson: (ctx: OpCtx, personId: string, i: { idpSubject: string }): Promise<Written & { personId: string }> =>
      c.run(ctx, async (tx) => {
        const state = await personState(tx, personId)
        await c.allow(ctx, 'person.activate', null)
        if (state !== 'invited') throw new BodiesError('INVALID', `person ${personId} is ${state}, only an invited person is activated`)
        const a = by(ctx.actor)
        const r = one(
          await tx<{ row_version: number; activated_at: Date }[]>`
            UPDATE idt.person SET account_state = 'active', idp_subject = ${i.idpSubject}, activated_at = now(), updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE person_id = ${personId}::uuid RETURNING row_version::int AS row_version, activated_at`,
          'person activate',
        )
        await c.emit(tx, ctx, 'person.activated', r.row_version, personId, { person_id: personId, activated_at: r.activated_at.toISOString() })
        return { personId, rowVersion: r.row_version }
      }),

    disablePerson: (ctx: OpCtx, personId: string): Promise<Written & { personId: string }> =>
      c.run(ctx, async (tx) => {
        const state = await personState(tx, personId)
        await c.allow(ctx, 'person.disable', null)
        if (state !== 'active') throw new BodiesError('INVALID', `person ${personId} is ${state}, only an active person is disabled`)
        const a = by(ctx.actor)
        const r = one(
          await tx<{ row_version: number; disabled_at: Date }[]>`
            UPDATE idt.person SET account_state = 'disabled', disabled_at = now(), updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE person_id = ${personId}::uuid RETURNING row_version::int AS row_version, disabled_at`,
          'person disable',
        )
        await c.emit(tx, ctx, 'person.disabled', r.row_version, personId, { person_id: personId, disabled_at: r.disabled_at.toISOString() })
        return { personId, rowVersion: r.row_version }
      }),

    enablePerson: (ctx: OpCtx, personId: string): Promise<Written & { personId: string }> =>
      c.run(ctx, async (tx) => {
        const state = await personState(tx, personId)
        await c.allow(ctx, 'person.enable', null)
        if (state !== 'disabled') throw new BodiesError('INVALID', `person ${personId} is ${state}, only a disabled person is enabled`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.person SET account_state = 'active', disabled_at = NULL, updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE person_id = ${personId}::uuid RETURNING row_version::int AS row_version`,
          'person enable',
        ).row_version
        await c.emit(tx, ctx, 'person.enabled', v, personId, { person_id: personId })
        return { personId, rowVersion: v }
      }),

    // ---------------------------------------------------------- memberships
    startMembership: (
      ctx: OpCtx,
      i: {
        personId: string
        bodyId: string
        orgUnitId?: string | null
        participationKind: ParticipationKind
        voting: boolean
        validFrom: string
        validUntil?: string | null
        wahlperiodeId?: string | null
        source: MembershipSource
      },
    ): Promise<Written & { membershipId: string }> =>
      c.run(ctx, async (tx) => {
        await c.activeBody(tx, i.bodyId)
        await c.allow(ctx, 'membership.start', i.bodyId)
        const person = one(await tx<{ account_state: string }[]>`SELECT account_state FROM idt.person WHERE person_id = ${i.personId}::uuid`, `person ${i.personId}`)
        if (person.account_state === 'erased') throw new BodiesError('INVALID', `person ${i.personId} is erased`)
        const a = by(ctx.actor)
        // voting is NOT pre-checked for a non_voting_helper: membership_voting_check (23514) is the guard.
        const r = one(
          await tx<{ membership_id: string; row_version: number }[]>`
            INSERT INTO idt.membership (customer_id, body_id, org_unit_id, person_id, participation_kind, voting, valid_from, valid_until, wahlperiode_id, source,
                                        created_by_kind, created_by, updated_by_kind, updated_by)
            VALUES (${ctx.customerId}::uuid, ${i.bodyId}::uuid, ${i.orgUnitId ?? null}, ${i.personId}::uuid, ${i.participationKind}, ${i.voting}, ${i.validFrom}::date,
                    ${i.validUntil ?? null}::date, ${i.wahlperiodeId ?? null}, ${i.source}, ${a.kind}, ${a.id}, ${a.kind}, ${a.id})
            RETURNING membership_id, row_version::int AS row_version`,
          'membership insert',
        )
        await c.emit(tx, ctx, 'membership.started', r.row_version, r.membership_id, {
          membership_id: r.membership_id, body_id: i.bodyId, org_unit_id: i.orgUnitId ?? null, person_id: i.personId, participation_kind: i.participationKind, voting: i.voting, valid_from: i.validFrom,
        })
        return { membershipId: r.membership_id, rowVersion: r.row_version }
      }),

    correctMembership: (
      ctx: OpCtx,
      membershipId: string,
      i: { voting?: boolean; validFrom?: string; validUntil?: string | null; wahlperiodeId?: string | null; expectedVersion?: number },
    ): Promise<Written & { membershipId: string }> =>
      c.run(ctx, async (tx) => {
        const m = one(
          await tx<{ body_id: string; voting: boolean; valid_from: string; valid_until: string | null; wahlperiode_id: string | null; row_version: number }[]>`
            SELECT body_id, voting, valid_from::text AS valid_from, valid_until::text AS valid_until, wahlperiode_id, row_version::int AS row_version
              FROM idt.membership WHERE membership_id = ${membershipId}::uuid FOR UPDATE`,
          `membership ${membershipId}`,
        )
        await c.allow(ctx, 'membership.correct', m.body_id)
        expectVersion(m.row_version, i.expectedVersion, `membership ${membershipId}`)
        const next = {
          voting: i.voting ?? m.voting,
          valid_from: i.validFrom ?? m.valid_from,
          valid_until: i.validUntil === undefined ? m.valid_until : i.validUntil,
          wahlperiode_id: i.wahlperiodeId === undefined ? m.wahlperiode_id : i.wahlperiodeId,
        }
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== m[k])
        if (changed.length === 0) throw new BodiesError('INVALID', `the correction of membership ${membershipId} changes nothing`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.membership SET voting = ${next.voting}, valid_from = ${next.valid_from}::date, valid_until = ${next.valid_until}::date, wahlperiode_id = ${next.wahlperiode_id},
                   updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE membership_id = ${membershipId}::uuid RETURNING row_version::int AS row_version`,
          'membership correct',
        ).row_version
        await c.emit(tx, ctx, 'membership.corrected', v, membershipId, { membership_id: membershipId, changed, valid_from: next.valid_from, valid_until: next.valid_until, voting: next.voting })
        return { membershipId, rowVersion: v }
      }),

    endMembership: (ctx: OpCtx, membershipId: string, i: { validUntil: string; endReason: 'term_end' | 'resigned' | 'removed' | 'data_correction' }): Promise<Written & { membershipId: string }> =>
      c.run(ctx, async (tx) => {
        const m = one(
          await tx<{ body_id: string; person_id: string; valid_until: string | null }[]>`
            SELECT body_id, person_id, valid_until::text AS valid_until FROM idt.membership WHERE membership_id = ${membershipId}::uuid FOR UPDATE`,
          `membership ${membershipId}`,
        )
        await c.allow(ctx, 'membership.end', m.body_id)
        if (m.valid_until !== null) throw new BodiesError('INVALID', `membership ${membershipId} is already ended`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.membership SET valid_until = ${i.validUntil}::date, end_reason = ${i.endReason}, updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE membership_id = ${membershipId}::uuid RETURNING row_version::int AS row_version`,
          'membership end',
        ).row_version
        await c.emit(tx, ctx, 'membership.ended', v, membershipId, { membership_id: membershipId, body_id: m.body_id, person_id: m.person_id, valid_until: i.validUntil, end_reason: i.endReason })
        return { membershipId, rowVersion: v }
      }),

    // -------------------------------------------------------------- tenures
    /**
     * Starts a tenure of `personId` on `seatId`. With `succession: true` the
     * seat's open tenure ends the day before (end_reason 'succeeded'; the new
     * tenure's source is 'succession') in the SAME transaction, so a
     * single-holder seat never has two holders (the gist EXCLUDE would refuse
     * it) and both events commit together.
     */
    startTenure: (
      ctx: OpCtx,
      i: { seatId: string; personId: string; startsOn: string; plannedEndOn?: string | null; wahlperiodeId?: string | null; source: TenureSource; mandateBeschlussRef?: string | null; succession?: boolean },
    ): Promise<Written & { tenureId: string }> =>
      c.run(ctx, async (tx) => {
        const s = one(
          await tx<{ body_id: string; holder_cardinality: string; seat_kind: string; state: string }[]>`
            SELECT body_id, holder_cardinality, seat_kind, state FROM idt.seat WHERE seat_id = ${i.seatId}::uuid FOR UPDATE`,
          `seat ${i.seatId}`,
        )
        await c.allow(ctx, 'tenure.start', s.body_id)
        if (s.state !== 'active') throw new BodiesError('INVALID', `seat ${i.seatId} is retired`)
        const a = by(ctx.actor)
        const source: TenureSource = i.succession ? 'succession' : i.source
        if (i.succession) {
          const [prev] = await tx<{ tenure_id: string; body_id: string; person_id: string; ended_day: string }[]>`
            SELECT tenure_id, body_id, person_id, (${i.startsOn}::date - 1)::text AS ended_day FROM idt.tenure
             WHERE seat_id = ${i.seatId}::uuid AND ended_on IS NULL FOR UPDATE`
          if (prev) {
            const e = one(
              await tx<{ row_version: number }[]>`
                UPDATE idt.tenure SET ended_on = ${prev.ended_day}::date, end_reason = 'succeeded', updated_by_kind = ${a.kind}, updated_by = ${a.id}
                 WHERE tenure_id = ${prev.tenure_id}::uuid RETURNING row_version::int AS row_version`,
              'tenure succeed',
            )
            await c.emit(tx, ctx, 'tenure.ended', e.row_version, prev.tenure_id, {
              tenure_id: prev.tenure_id, seat_id: i.seatId, seat_kind: s.seat_kind, body_id: prev.body_id, person_id: prev.person_id, ended_on: prev.ended_day, end_reason: 'succeeded',
            })
          }
        }
        const r = one(
          await tx<{ tenure_id: string; row_version: number }[]>`
            INSERT INTO idt.tenure (customer_id, body_id, seat_id, seat_holder_cardinality, person_id, wahlperiode_id, starts_on, planned_end_on, source, mandate_beschluss_ref,
                                    created_by_kind, created_by, updated_by_kind, updated_by)
            VALUES (${ctx.customerId}::uuid, ${s.body_id}::uuid, ${i.seatId}::uuid, ${s.holder_cardinality}, ${i.personId}::uuid, ${i.wahlperiodeId ?? null}, ${i.startsOn}::date,
                    ${i.plannedEndOn ?? null}::date, ${source}, ${i.mandateBeschlussRef ?? null}, ${a.kind}, ${a.id}, ${a.kind}, ${a.id})
            RETURNING tenure_id, row_version::int AS row_version`,
          'tenure insert',
        )
        await c.emit(tx, ctx, 'tenure.started', r.row_version, r.tenure_id, {
          tenure_id: r.tenure_id, seat_id: i.seatId, seat_kind: s.seat_kind, body_id: s.body_id, person_id: i.personId, starts_on: i.startsOn, source, mandate_beschluss_ref: i.mandateBeschlussRef ?? null,
        })
        return { tenureId: r.tenure_id, rowVersion: r.row_version }
      }),

    correctTenure: (ctx: OpCtx, tenureId: string, i: { startsOn?: string; plannedEndOn?: string | null; endedOn?: string; expectedVersion?: number }): Promise<Written & { tenureId: string }> =>
      c.run(ctx, async (tx) => {
        const t = one(
          await tx<{ body_id: string; starts_on: string; planned_end_on: string | null; ended_on: string | null; row_version: number; seat_kind: string }[]>`
            SELECT t.body_id, t.starts_on::text AS starts_on, t.planned_end_on::text AS planned_end_on, t.ended_on::text AS ended_on, t.row_version::int AS row_version, s.seat_kind
              FROM idt.tenure t JOIN idt.seat s ON s.seat_id = t.seat_id WHERE t.tenure_id = ${tenureId}::uuid FOR UPDATE OF t`,
          `tenure ${tenureId}`,
        )
        await c.allow(ctx, 'tenure.correct', t.body_id)
        expectVersion(t.row_version, i.expectedVersion, `tenure ${tenureId}`)
        if (i.endedOn !== undefined && t.ended_on === null) throw new BodiesError('INVALID', `tenure ${tenureId} is open: end it with endTenure, a correction only moves an existing end`)
        const next = { starts_on: i.startsOn ?? t.starts_on, planned_end_on: i.plannedEndOn === undefined ? t.planned_end_on : i.plannedEndOn, ended_on: i.endedOn ?? t.ended_on }
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== t[k])
        if (changed.length === 0) throw new BodiesError('INVALID', `the correction of tenure ${tenureId} changes nothing`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.tenure SET starts_on = ${next.starts_on}::date, planned_end_on = ${next.planned_end_on}::date, ended_on = ${next.ended_on}::date, updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE tenure_id = ${tenureId}::uuid RETURNING row_version::int AS row_version`,
          'tenure correct',
        ).row_version
        await c.emit(tx, ctx, 'tenure.corrected', v, tenureId, { tenure_id: tenureId, seat_kind: t.seat_kind, changed, starts_on: next.starts_on, ended_on: next.ended_on })
        return { tenureId, rowVersion: v }
      }),

    endTenure: (ctx: OpCtx, tenureId: string, i: { endedOn: string; endReason: 'term_end' | 'resigned' | 'removed' | 'succeeded' | 'data_correction' }): Promise<Written & { tenureId: string }> =>
      c.run(ctx, async (tx) => {
        const t = one(
          await tx<{ body_id: string; seat_id: string; person_id: string; ended_on: string | null; seat_kind: string }[]>`
            SELECT t.body_id, t.seat_id, t.person_id, t.ended_on::text AS ended_on, s.seat_kind
              FROM idt.tenure t JOIN idt.seat s ON s.seat_id = t.seat_id WHERE t.tenure_id = ${tenureId}::uuid FOR UPDATE OF t`,
          `tenure ${tenureId}`,
        )
        await c.allow(ctx, 'tenure.end', t.body_id)
        if (t.ended_on !== null) throw new BodiesError('INVALID', `tenure ${tenureId} is already ended`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.tenure SET ended_on = ${i.endedOn}::date, end_reason = ${i.endReason}, updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE tenure_id = ${tenureId}::uuid RETURNING row_version::int AS row_version`,
          'tenure end',
        ).row_version
        await c.emit(tx, ctx, 'tenure.ended', v, tenureId, { tenure_id: tenureId, seat_id: t.seat_id, seat_kind: t.seat_kind, body_id: t.body_id, person_id: t.person_id, ended_on: i.endedOn, end_reason: i.endReason })
        return { tenureId, rowVersion: v }
      }),
  }
}
