// services/kernel-api/src/bodies/structure.ts -- bodies, org units, seats,
// wahlperioden (the structure half of the domain service; see core.ts for the
// rules every operation obeys).
import { BodiesError } from './errors.ts'
import { by, expectVersion, one, type Core, type OpCtx, type Written } from './core.ts'

export function structureOps(c: Core) {
  return {
    // ------------------------------------------------------------- bodies
    createBody: (ctx: OpCtx, i: { kindKey: string; name: string; shortName?: string | null; parentBodyId?: string | null }): Promise<Written & { bodyId: string }> =>
      c.run(ctx, async (tx) => {
        await c.allow(ctx, 'body.create', i.parentBodyId ?? null)
        await c.kindOf(tx, ctx.customerId, i.kindKey, 'body')
        const a = by(ctx.actor)
        const r = one(
          await tx<{ body_id: string; row_version: number }[]>`
            INSERT INTO idt.body (customer_id, kind_key, name, short_name, parent_body_id, created_by_kind, created_by, updated_by_kind, updated_by)
            VALUES (${ctx.customerId}::uuid, ${i.kindKey}, ${i.name}, ${i.shortName ?? null}, ${i.parentBodyId ?? null}, ${a.kind}, ${a.id}, ${a.kind}, ${a.id})
            RETURNING body_id, row_version::int AS row_version`,
          'body insert',
        )
        await c.emit(tx, ctx, 'body.created', r.row_version, r.body_id, { body_id: r.body_id, kind_key: i.kindKey, parent_body_id: i.parentBodyId ?? null })
        return { bodyId: r.body_id, rowVersion: r.row_version }
      }),

    updateBody: (ctx: OpCtx, bodyId: string, i: { name?: string; shortName?: string | null; parentBodyId?: string | null; expectedVersion?: number }): Promise<Written & { bodyId: string }> =>
      c.run(ctx, async (tx) => {
        const b = one(
          await tx<{ kind_key: string; name: string; short_name: string | null; parent_body_id: string | null; state: string; row_version: number }[]>`
            SELECT kind_key, name, short_name, parent_body_id, state, row_version::int AS row_version FROM idt.body WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid FOR UPDATE`,
          `body ${bodyId}`,
        )
        await c.allow(ctx, 'body.update', bodyId)
        if (b.state !== 'active') throw new BodiesError('INVALID', `body ${bodyId} is archived`)
        expectVersion(b.row_version, i.expectedVersion, `body ${bodyId}`)
        const parent = i.parentBodyId === undefined ? b.parent_body_id : i.parentBodyId
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.body SET name = ${i.name ?? b.name}, short_name = ${i.shortName === undefined ? b.short_name : i.shortName}, parent_body_id = ${parent},
                   updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid RETURNING row_version::int AS row_version`,
          'body update',
        ).row_version
        await c.emit(tx, ctx, 'body.updated', v, bodyId, { body_id: bodyId, kind_key: b.kind_key, parent_body_id: parent })
        return { bodyId, rowVersion: v }
      }),

    archiveBody: (ctx: OpCtx, bodyId: string): Promise<Written & { bodyId: string }> =>
      c.run(ctx, async (tx) => {
        const b = one(await tx<{ state: string }[]>`SELECT state FROM idt.body WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid FOR UPDATE`, `body ${bodyId}`)
        await c.allow(ctx, 'body.archive', bodyId)
        if (b.state === 'archived') throw new BodiesError('INVALID', `body ${bodyId} is already archived`)
        const open = one(
          await tx<{ n: number }[]>`
            SELECT ((SELECT count(*) FROM idt.org_unit WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid AND state = 'active')
                  + (SELECT count(*) FROM idt.seat WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid AND state = 'active')
                  + (SELECT count(*) FROM idt.membership WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid AND valid_until IS NULL)
                  + (SELECT count(*) FROM idt.tenure WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid AND ended_on IS NULL))::int AS n`,
          'body usage',
        ).n
        if (open > 0) throw new BodiesError('CONFLICT', `body ${bodyId} still has ${open} active org unit(s), seat(s), open membership(s) or tenure(s)`)
        const a = by(ctx.actor)
        const r = one(
          await tx<{ row_version: number; archived_at: Date }[]>`
            UPDATE idt.body SET state = 'archived', archived_at = now(), updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE customer_id = ${ctx.customerId}::uuid AND body_id = ${bodyId}::uuid RETURNING row_version::int AS row_version, archived_at`,
          'body archive',
        )
        await c.emit(tx, ctx, 'body.archived', r.row_version, bodyId, { body_id: bodyId, archived_at: r.archived_at.toISOString() })
        return { bodyId, rowVersion: r.row_version }
      }),

    // ----------------------------------------------------------- org units
    createOrgUnit: (ctx: OpCtx, i: { bodyId: string; kindKey: string; name: string; parentOrgUnitId?: string | null }): Promise<Written & { orgUnitId: string }> =>
      c.run(ctx, async (tx) => {
        await c.allow(ctx, 'orgunit.create', i.bodyId)
        await c.activeBody(tx, ctx.customerId, i.bodyId)
        const k = await c.kindOf(tx, ctx.customerId, i.kindKey, 'unit')
        const a = by(ctx.actor)
        const r = one(
          await tx<{ org_unit_id: string; row_version: number }[]>`
            INSERT INTO idt.org_unit (customer_id, body_id, parent_org_unit_id, kind_key, name, created_by_kind, created_by, updated_by_kind, updated_by)
            VALUES (${ctx.customerId}::uuid, ${i.bodyId}::uuid, ${i.parentOrgUnitId ?? null}, ${i.kindKey}, ${i.name}, ${a.kind}, ${a.id}, ${a.kind}, ${a.id})
            RETURNING org_unit_id, row_version::int AS row_version`,
          'org unit insert',
        )
        await c.emit(tx, ctx, 'orgunit.created', r.row_version, r.org_unit_id, {
          org_unit_id: r.org_unit_id, body_id: i.bodyId, parent_org_unit_id: i.parentOrgUnitId ?? null, kind_key: i.kindKey, is_organ: k.is_organ,
        })
        return { orgUnitId: r.org_unit_id, rowVersion: r.row_version }
      }),

    updateOrgUnit: (ctx: OpCtx, orgUnitId: string, i: { name?: string; parentOrgUnitId?: string | null; expectedVersion?: number }): Promise<Written & { orgUnitId: string }> =>
      c.run(ctx, async (tx) => {
        const u = one(
          await tx<{ body_id: string; kind_key: string; name: string; parent_org_unit_id: string | null; state: string; row_version: number }[]>`
            SELECT body_id, kind_key, name, parent_org_unit_id, state, row_version::int AS row_version FROM idt.org_unit WHERE customer_id = ${ctx.customerId}::uuid AND org_unit_id = ${orgUnitId}::uuid FOR UPDATE`,
          `org unit ${orgUnitId}`,
        )
        await c.allow(ctx, 'orgunit.update', u.body_id)
        if (u.state !== 'active') throw new BodiesError('INVALID', `org unit ${orgUnitId} is archived`)
        expectVersion(u.row_version, i.expectedVersion, `org unit ${orgUnitId}`)
        const parent = i.parentOrgUnitId === undefined ? u.parent_org_unit_id : i.parentOrgUnitId
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.org_unit SET name = ${i.name ?? u.name}, parent_org_unit_id = ${parent}, updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE customer_id = ${ctx.customerId}::uuid AND org_unit_id = ${orgUnitId}::uuid RETURNING row_version::int AS row_version`,
          'org unit update',
        ).row_version
        await c.emit(tx, ctx, 'orgunit.updated', v, orgUnitId, { org_unit_id: orgUnitId, body_id: u.body_id, kind_key: u.kind_key })
        return { orgUnitId, rowVersion: v }
      }),

    archiveOrgUnit: (ctx: OpCtx, orgUnitId: string): Promise<Written & { orgUnitId: string }> =>
      c.run(ctx, async (tx) => {
        const u = one(await tx<{ body_id: string; state: string }[]>`SELECT body_id, state FROM idt.org_unit WHERE customer_id = ${ctx.customerId}::uuid AND org_unit_id = ${orgUnitId}::uuid FOR UPDATE`, `org unit ${orgUnitId}`)
        await c.allow(ctx, 'orgunit.archive', u.body_id)
        if (u.state === 'archived') throw new BodiesError('INVALID', `org unit ${orgUnitId} is already archived`)
        const open = one(
          await tx<{ n: number }[]>`
            SELECT ((SELECT count(*) FROM idt.org_unit WHERE customer_id = ${ctx.customerId}::uuid AND parent_org_unit_id = ${orgUnitId}::uuid AND state = 'active')
                  + (SELECT count(*) FROM idt.seat WHERE customer_id = ${ctx.customerId}::uuid AND org_unit_id = ${orgUnitId}::uuid AND state = 'active')
                  + (SELECT count(*) FROM idt.membership WHERE customer_id = ${ctx.customerId}::uuid AND org_unit_id = ${orgUnitId}::uuid AND valid_until IS NULL))::int AS n`,
          'org unit usage',
        ).n
        if (open > 0) throw new BodiesError('CONFLICT', `org unit ${orgUnitId} still has ${open} active child unit(s), seat(s) or open membership(s)`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.org_unit SET state = 'archived', archived_at = now(), updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE customer_id = ${ctx.customerId}::uuid AND org_unit_id = ${orgUnitId}::uuid RETURNING row_version::int AS row_version`,
          'org unit archive',
        ).row_version
        await c.emit(tx, ctx, 'orgunit.archived', v, orgUnitId, { org_unit_id: orgUnitId, body_id: u.body_id })
        return { orgUnitId, rowVersion: v }
      }),

    // --------------------------------------------------------------- seats
    createSeat: (
      ctx: OpCtx,
      i: {
        bodyId: string
        orgUnitId?: string | null
        title: string
        seatKind: 'voting_member' | 'office' | 'advisory'
        fillMode: 'direct_election' | 'delegation' | 'appointment'
        delegatingBodyId?: string | null
        conferredRoleKey?: string | null
        holderCardinality?: 'single' | 'multiple'
        voting: boolean
      },
    ): Promise<Written & { seatId: string }> =>
      c.run(ctx, async (tx) => {
        await c.allow(ctx, 'seat.create', i.bodyId)
        await c.activeBody(tx, ctx.customerId, i.bodyId)
        if (i.orgUnitId) {
          const unit = one(
            await tx<{ can_hold_seats: boolean; state: string }[]>`
              SELECT k.can_hold_seats, u.state FROM idt.org_unit u JOIN idt.org_unit_kind k ON k.customer_id = u.customer_id AND k.kind_key = u.kind_key AND k.level = u.kind_level
               WHERE u.customer_id = ${ctx.customerId}::uuid AND u.org_unit_id = ${i.orgUnitId}::uuid AND u.body_id = ${i.bodyId}::uuid`,
            `org unit ${i.orgUnitId} of body ${i.bodyId}`,
          )
          if (unit.state !== 'active' || !unit.can_hold_seats) throw new BodiesError('INVALID', `org unit ${i.orgUnitId} cannot hold seats (archived, or its kind does not allow seats)`)
        }
        const a = by(ctx.actor)
        const r = one(
          await tx<{ seat_id: string; row_version: number }[]>`
            INSERT INTO idt.seat (customer_id, body_id, org_unit_id, title, seat_kind, fill_mode, delegating_body_id, conferred_role_key, holder_cardinality, voting,
                                  created_by_kind, created_by, updated_by_kind, updated_by)
            VALUES (${ctx.customerId}::uuid, ${i.bodyId}::uuid, ${i.orgUnitId ?? null}, ${i.title}, ${i.seatKind}, ${i.fillMode}, ${i.delegatingBodyId ?? null}, ${i.conferredRoleKey ?? null},
                    ${i.holderCardinality ?? 'single'}, ${i.voting}, ${a.kind}, ${a.id}, ${a.kind}, ${a.id})
            RETURNING seat_id, row_version::int AS row_version`,
          'seat insert',
        )
        await c.emit(tx, ctx, 'seat.created', r.row_version, r.seat_id, {
          seat_id: r.seat_id, body_id: i.bodyId, org_unit_id: i.orgUnitId ?? null, seat_kind: i.seatKind, fill_mode: i.fillMode, voting: i.voting,
        })
        return { seatId: r.seat_id, rowVersion: r.row_version }
      }),

    retireSeat: (ctx: OpCtx, seatId: string): Promise<Written & { seatId: string }> =>
      c.run(ctx, async (tx) => {
        const s = one(await tx<{ body_id: string; state: string }[]>`SELECT body_id, state FROM idt.seat WHERE customer_id = ${ctx.customerId}::uuid AND seat_id = ${seatId}::uuid FOR UPDATE`, `seat ${seatId}`)
        await c.allow(ctx, 'seat.retire', s.body_id)
        if (s.state === 'retired') throw new BodiesError('INVALID', `seat ${seatId} is already retired`)
        const open = one(await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM idt.tenure WHERE customer_id = ${ctx.customerId}::uuid AND seat_id = ${seatId}::uuid AND ended_on IS NULL`, 'seat usage').n
        if (open > 0) throw new BodiesError('CONFLICT', `seat ${seatId} still has an open tenure`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.seat SET state = 'retired', retired_at = now(), updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE customer_id = ${ctx.customerId}::uuid AND seat_id = ${seatId}::uuid RETURNING row_version::int AS row_version`,
          'seat retire',
        ).row_version
        await c.emit(tx, ctx, 'seat.retired', v, seatId, { seat_id: seatId, body_id: s.body_id })
        return { seatId, rowVersion: v }
      }),

    // --------------------------------------------------------- wahlperioden
    createWahlperiode: (ctx: OpCtx, i: { bodyId: string; orgUnitId?: string | null; label: string; startsOn: string; endsOn: string }): Promise<Written & { wahlperiodeId: string }> =>
      c.run(ctx, async (tx) => {
        await c.allow(ctx, 'wahlperiode.create', i.bodyId)
        await c.activeBody(tx, ctx.customerId, i.bodyId)
        const a = by(ctx.actor)
        const r = one(
          await tx<{ wahlperiode_id: string; row_version: number }[]>`
            INSERT INTO idt.wahlperiode (customer_id, body_id, org_unit_id, label, starts_on, ends_on, created_by_kind, created_by, updated_by_kind, updated_by)
            VALUES (${ctx.customerId}::uuid, ${i.bodyId}::uuid, ${i.orgUnitId ?? null}, ${i.label}, ${i.startsOn}::date, ${i.endsOn}::date, ${a.kind}, ${a.id}, ${a.kind}, ${a.id})
            RETURNING wahlperiode_id, row_version::int AS row_version`,
          'wahlperiode insert',
        )
        await c.emit(tx, ctx, 'wahlperiode.created', r.row_version, r.wahlperiode_id, {
          wahlperiode_id: r.wahlperiode_id, body_id: i.bodyId, org_unit_id: i.orgUnitId ?? null, starts_on: i.startsOn, ends_on: i.endsOn,
        })
        return { wahlperiodeId: r.wahlperiode_id, rowVersion: r.row_version }
      }),

    closeWahlperiode: (ctx: OpCtx, wahlperiodeId: string): Promise<Written & { wahlperiodeId: string }> =>
      c.run(ctx, async (tx) => {
        const w = one(await tx<{ body_id: string; state: string }[]>`SELECT body_id, state FROM idt.wahlperiode WHERE customer_id = ${ctx.customerId}::uuid AND wahlperiode_id = ${wahlperiodeId}::uuid FOR UPDATE`, `wahlperiode ${wahlperiodeId}`)
        await c.allow(ctx, 'wahlperiode.close', w.body_id)
        if (w.state === 'closed') throw new BodiesError('INVALID', `wahlperiode ${wahlperiodeId} is already closed`)
        const a = by(ctx.actor)
        const v = one(
          await tx<{ row_version: number }[]>`
            UPDATE idt.wahlperiode SET state = 'closed', updated_by_kind = ${a.kind}, updated_by = ${a.id}
             WHERE customer_id = ${ctx.customerId}::uuid AND wahlperiode_id = ${wahlperiodeId}::uuid RETURNING row_version::int AS row_version`,
          'wahlperiode close',
        ).row_version
        await c.emit(tx, ctx, 'wahlperiode.closed', v, wahlperiodeId, { wahlperiode_id: wahlperiodeId, body_id: w.body_id })
        return { wahlperiodeId, rowVersion: v }
      }),
  }
}
