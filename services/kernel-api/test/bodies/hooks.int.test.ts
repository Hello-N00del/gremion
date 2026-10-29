// TASK-080-a step e (live half): the migrate hook on a customer database made by
// ensureKernelDatabase (t_<hex32>__kernel, non-superuser owner/app roles), UNSEEDED:
// btree_gist in schema idt, exactly one database_binding row, one customer_setting
// row, the vendor kinds, a re-run that changes nothing, a binding for ANOTHER
// customer refused, and the RLS refusal of a step that forgot the GUC.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VENDOR_BODY_KINDS, VENDOR_KINDS } from '../../src/bodies/kinds.ts'
import { afterKernelRun, HookError, tenantTokenOf } from '../../src/migrate/idt-hooks.ts'
import { asCustomer, buildBodiesWorld, type BodiesWorld } from '../harness/bodies-world.ts'
import { uuidv7, type Customer } from '../harness/scratch.ts'

let w: BodiesWorld
let A: Customer

beforeAll(async () => {
  w = await buildBodiesWorld('hooks')
  A = await w.customer('hook-a', 'hook-a.example.org')
}, 240_000)
afterAll(async () => {
  await w?.close()
})

describe('the idt migrate hook (brief G4, A2)', () => {
  it('btree_gist is installed in schema idt, and the gist EXCLUDE constraints exist on membership and tenure', async () => {
    const admin = w.adminPool(A)
    const ext = await admin<{ schema: string }[]>`SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'btree_gist'`
    expect(ext).toEqual([{ schema: 'idt' }])
    const excl = await admin<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'x' AND connamespace = 'idt'::regnamespace ORDER BY conname`
    expect(excl.map((e) => e.conname)).toEqual(['membership_person_id_body_id_unit_kind_validity_excl', 'tenure_seat_id_starts_on_ended_on_excl'])
    expect(excl[0]!.def).toContain('EXCLUDE USING gist')
  })

  it('exactly one database_binding row (this customer, context idt), one customer_setting row (de / du / Europe/Berlin)', async () => {
    const admin = w.adminPool(A)
    expect(await admin`SELECT customer_id::text, context_code, tenant_token FROM idt.database_binding`).toEqual([{ customer_id: A.id, context_code: 'idt', tenant_token: tenantTokenOf(A.id) }])
    expect(await admin`SELECT customer_id::text, form_of_address, default_locale, time_zone FROM idt.customer_setting`).toEqual([
      { customer_id: A.id, form_of_address: 'du', default_locale: 'de', time_zone: 'Europe/Berlin' },
    ])
  })

  it('the six vendor body kinds (stura, stupa, fachschaftsrat, referat, initiative, verwaltung) and the vertical unit kinds are seeded as vendor_default', async () => {
    const admin = w.adminPool(A)
    const bodies = await admin<{ kind_key: string }[]>`SELECT kind_key FROM idt.org_unit_kind WHERE level = 'body' AND origin = 'vendor_default' ORDER BY kind_key`
    expect(bodies.map((k) => k.kind_key)).toEqual(['fachschaftsrat', 'initiative', 'referat', 'stupa', 'stura', 'verwaltung'])
    expect(VENDOR_BODY_KINDS).toHaveLength(6)
    const [n] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM idt.org_unit_kind`
    expect(n!.n).toBe(VENDOR_KINDS.length)
  })

  it('a re-run changes nothing: no file applied, the counts and every row_version stay', async () => {
    const admin = w.adminPool(A)
    const before = await admin`SELECT (SELECT count(*)::int FROM idt.org_unit_kind) AS kinds, (SELECT count(*)::int FROM idt.customer_setting) AS settings,
      (SELECT count(*)::int FROM idt.database_binding) AS bindings, (SELECT sum(row_version)::int FROM idt.org_unit_kind) AS kind_versions, (SELECT row_version::int FROM idt.customer_setting) AS setting_version`
    const r = await w.migrate(['--customer', A.id])
    expect(r.code, r.lines.join('\n')).toBe(0)
    expect(r.lines.join('\n')).toContain('applied=0')
    expect(await admin`SELECT (SELECT count(*)::int FROM idt.org_unit_kind) AS kinds, (SELECT count(*)::int FROM idt.customer_setting) AS settings,
      (SELECT count(*)::int FROM idt.database_binding) AS bindings, (SELECT sum(row_version)::int FROM idt.org_unit_kind) AS kind_versions, (SELECT row_version::int FROM idt.customer_setting) AS setting_version`).toEqual(before)
  })

  it('a customer edit survives a re-run (a kind label changed by the customer is not reset)', async () => {
    const admin = w.adminPool(A)
    await admin`UPDATE idt.org_unit_kind SET label_de = 'Eigener Name' WHERE kind_key = 'referat'`
    expect((await w.migrate(['--customer', A.id])).code).toBe(0)
    expect(await admin`SELECT label_de FROM idt.org_unit_kind WHERE kind_key = 'referat'`).toEqual([{ label_de: 'Eigener Name' }])
  })

  it('a binding for ANOTHER customer is refused, never rewritten', async () => {
    const admin = w.adminPool(A)
    const other = uuidv7()
    await admin`UPDATE idt.database_binding SET customer_id = ${other}::uuid`
    const sql = w.appPool(A)
    const hex = A.id.replaceAll('-', '')
    await expect(afterKernelRun(sql, { customerId: A.id, owner: `k_${hex}_owner` })).rejects.toThrow(HookError)
    expect(await admin`SELECT customer_id::text FROM idt.database_binding`).toEqual([{ customer_id: other }])
    await admin`UPDATE idt.database_binding SET customer_id = ${A.id}::uuid`
  })

  it('a step without the GUC is refused by row level security (the owner is held to the policy: FORCE)', async () => {
    const sql = w.appPool(A)
    const hex = A.id.replaceAll('-', '')
    const err = await sql
      .begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE "k_${hex}_owner"`)
        await tx`INSERT INTO idt.customer_setting (customer_id, time_zone, created_by_kind, updated_by_kind) VALUES (${uuidv7()}::uuid, 'Europe/Berlin', 'system', 'system')`
      })
      .then(() => null, (e: unknown) => e as { code?: string; message?: string })
    expect(err?.code).toBe('42501')
    expect(err?.message).toMatch(/row-level security/)
    // and with the GUC of ANOTHER customer the same insert is refused too
    const err2 = await asCustomer(sql, uuidv7(), async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE "k_${hex}_owner"`)
      await tx`INSERT INTO idt.customer_setting (customer_id, time_zone, created_by_kind, updated_by_kind) VALUES (${A.id}::uuid, 'Europe/Berlin', 'system', 'system')`
    }).then(() => null, (e: unknown) => e as { code?: string })
    expect(err2?.code).toBe('42501')
  })
})
