// services/kernel-api/src/migrate/idt-hooks.ts -- the migrate hook (TASK-080-a
// brief G4): what `kernel-api migrate` does around the chain's files, per
// customer, on the SAME direct connection and as the customer's OWNER role.
//
//   beforeRun   CREATE SCHEMA IF NOT EXISTS idt + CREATE EXTENSION IF NOT EXISTS
//               btree_gist WITH SCHEMA idt (the gist EXCLUDEs of
//               idt.membership / idt.tenure need it; a migration file may not
//               CREATE EXTENSION -- the lint refuses it);
//   afterRun    ensureBinding        exactly one idt.database_binding row (the
//                                    customer's; one bound to ANOTHER customer is
//                                    refused, never rewritten);
//               ensureCustomerSetting one row, de / du, time zone Europe/Berlin;
//               ensureVendorKinds    the vendor-default kind catalogue (kinds.ts).
//
// Every row insert runs in a transaction that FIRST sets gremion.customer_id
// (set_config, transaction local): the idt tables are FORCE ROW LEVEL SECURITY,
// so the owner is held to the policy too, and a step without the GUC is refused
// by the database (test: hook without the GUC -> RLS refusal). Every step is
// idempotent: a re-run changes nothing and leaves a customer's own edits alone.
import type { Sql } from '@gremion/db'
import { VENDOR_KINDS } from '../bodies/kinds.ts'

const OWNER_ROLE = /^k_[0-9a-f]{32}_owner$/

export interface HookTarget {
  customerId: string
  /** The customer's owner role, k_<hex32>_owner. */
  owner: string
}

export class HookError extends Error {
  override name = 'HookError'
}

/** idt.database_binding.tenant_token: t_<hex32> satisfies its CHECK (^[a-z][a-z0-9_]{2,39}$) and names no host. */
export const tenantTokenOf = (customerId: string): string => `t_${customerId.replaceAll('-', '')}`

function assertTarget(t: HookTarget): void {
  if (!OWNER_ROLE.test(t.owner)) throw new HookError(`refusing owner role ${JSON.stringify(t.owner)}`)
  if (t.owner !== `k_${t.customerId.replaceAll('-', '')}_owner`) throw new HookError(`owner role ${t.owner} does not belong to customer ${t.customerId}`)
}

export async function beforeKernelRun(sql: Sql, t: HookTarget): Promise<void> {
  assertTarget(t)
  // SET LOCAL ROLE needs a transaction; the extension is created by the owner (a database owner may create a trusted extension).
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${t.owner}"`)
    await tx`CREATE SCHEMA IF NOT EXISTS idt`
    await tx`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA idt`
  })
}

export interface AfterRunResult {
  bindingCreated: boolean
  customerSettingCreated: boolean
  kindsCreated: number
}

export async function afterKernelRun(sql: Sql, t: HookTarget): Promise<AfterRunResult> {
  assertTarget(t)
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${t.owner}"`)
    await tx`SELECT set_config('gremion.customer_id', ${t.customerId}, true)`

    const bound = await tx<{ customer_id: string }[]>`
      INSERT INTO idt.database_binding (customer_id, tenant_token, context_code) VALUES (${t.customerId}::uuid, ${tenantTokenOf(t.customerId)}, 'idt')
      ON CONFLICT (singleton) DO NOTHING RETURNING customer_id`
    const [binding] = await tx<{ customer_id: string; context_code: string }[]>`SELECT customer_id, context_code FROM idt.database_binding`
    if (!binding || binding.customer_id !== t.customerId || binding.context_code !== 'idt') {
      throw new HookError(`idt.database_binding is bound to ${binding ? `${binding.context_code} of customer ${binding.customer_id}` : 'nothing'}, not to idt of customer ${t.customerId}: refusing to continue`)
    }

    const setting = await tx<{ customer_id: string }[]>`
      INSERT INTO idt.customer_setting (customer_id, form_of_address, default_locale, time_zone, created_by_kind, updated_by_kind)
      VALUES (${t.customerId}::uuid, 'du', 'de', 'Europe/Berlin', 'system', 'system') ON CONFLICT (customer_id) DO NOTHING RETURNING customer_id`

    let kinds = 0
    for (const k of VENDOR_KINDS) {
      const r = await tx<{ kind_key: string }[]>`
        INSERT INTO idt.org_unit_kind (kind_key, customer_id, level, label_de, label_en, is_organ, can_hold_seats, may_adopt_beschluesse, allowed_parent_kinds, origin, created_by_kind, updated_by_kind)
        VALUES (${k.kindKey}, ${t.customerId}::uuid, ${k.level}, ${k.labelDe}, ${k.labelEn}, ${k.isOrgan}, ${k.canHoldSeats}, ${k.mayAdoptBeschluesse}, ${[...k.allowedParentKinds]}::text[], 'vendor_default', 'system', 'system')
        ON CONFLICT (kind_key) DO NOTHING RETURNING kind_key`
      kinds += r.length
    }
    return { bindingCreated: bound.length === 1, customerSettingCreated: setting.length === 1, kindsCreated: kinds } satisfies AfterRunResult
  })) as AfterRunResult
}
