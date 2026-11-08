// src/lib/server/files/karenz.ts
// Module Karenz (phase 2, Task 16): the files participant.
//
// Files are NEVER deleted by a switch-off. What the files module owns per org unit is the binding: the
// Nextcloud provisioning ledger row (external id "<folderId>:<groupId>") and the wants_nextcloud_folder
// flag that makes the provisioning worker keep a folder for the unit. Switch-off releases exactly that:
// the row and the flag go, the external id is recorded in the Karenz item, and the Nextcloud folder, its
// group and every file stay untouched (the teardown handed to releaseSubsystem is a no-op). Restore puts
// the SAME external id back, so the unit is provisioned again by reusing the folder (ensureResource gets
// it as `existing`). The final day deletes nothing in Nextcloud. This file does not import the
// Nextcloud client at all: it has no way to delete anything there.
//
// Everything is idempotent (the pass runs again after a crash) and processes ALL units before it fails:
// a failure is a KarenzPartialError whose labels carry the org unit id only, never a folder or group id
// or a unit name.
import { getOrgUnit, listOrgUnits, setSubsystemWanted } from '$lib/server/governance/org-units-db'
import { enqueueResources, getResource, markResourceOk } from '$lib/server/governance/provisioning/ledger'
import { releaseSubsystem } from '$lib/server/governance/provisioning/orchestrator'
import { getDb } from '$lib/server/db'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import {
  KarenzPartialError,
  type DeletionItem, type KarenzContext, type KarenzParticipant, type RetainedItem,
} from '$lib/server/module-karenz/participants'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'

const BINDING = 'file_binding'

/** Item states from which switchOff still has work (recorded: the release was not confirmed). */
const SWITCH_OFF_PENDING = new Set<string>(['recorded', 'lock_failed'])
/** Item states in which restore has nothing left to do. */
const RESTORE_DONE = new Set<string>(['restored', 'kept', 'gone', 'deleted'])

function unitOf(item: KarenzItemRow): string | null {
  const p = item.payload
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const id = (p as { unitId?: unknown }).unitId
    if (typeof id === 'string' && id !== '') return id
  }
  return null
}

/** False when the unit had a ledger row but no folder yet (the folder was never created). */
function wasBound(item: KarenzItemRow): boolean {
  const p = item.payload
  return !(p && typeof p === 'object' && !Array.isArray(p) && (p as { bound?: unknown }).bound === false)
}

/** A label for the operator log that names the unit, never the folder or the group. */
function unitLabel(unitId: string | null): string {
  return `unit ${unitId ?? 'unknown'}`
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : 'Error'
}

/** The full error goes to the server log only; the unit is named by id. */
function logServerSide(what: string, unitId: string | null, err: unknown): void {
  console.error(`[karenz/files] ${what}`, { unitId, err })
}

/** Bookkeeping inside a catch path: a failing write must not abort the loop, or the units after it would
 *  never be processed. Reports whether it was written. */
async function trySetState(ctx: KarenzContext, item: KarenzItemRow, state: ItemState, detail?: string): Promise<boolean> {
  try {
    await ctx.items.setState(item.itemId, state, detail)
    return true
  } catch (err) {
    logServerSide('item state could not be recorded', unitOf(item), err)
    return false
  }
}

async function switchOff(ctx: KarenzContext): Promise<void> {
  // 1. record first (an upsert never undoes what an earlier pass did to the item), so a crash between
  //    the release and the bookkeeping finds the unit again and the external id is never lost.
  for (const unit of await listOrgUnits()) {
    const row = await getResource(unit.id, 'nextcloud')
    if (!row) continue // never had a Nextcloud binding, or an earlier pass released it (its item exists)
    const bound = row.external_id !== null && row.external_id !== ''
    await ctx.items.upsert({
      kind: BINDING,
      // a unit without a folder yet has no external id: its own id keeps the item unique per unit
      externalId: bound ? row.external_id! : `unit:${unit.id}`,
      state: 'recorded',
      payload: { unitId: unit.id, bound },
    })
  }

  // 2. release the binding of what is recorded; one failing unit never stops the others.
  const failures: string[] = []
  for (const item of await ctx.items.list(BINDING)) {
    if (!SWITCH_OFF_PENDING.has(item.state)) continue
    const unitId = unitOf(item)
    if (unitId === null) continue // not one of ours
    try {
      // The teardown is deliberately empty: the folder, its group and its files are not ours to remove.
      // Releasing an already released unit is a no-op (no row, flag already off).
      await releaseSubsystem(unitId, 'nextcloud', async () => undefined)
    } catch (err) {
      failures.push(unitLabel(unitId))
      ctx.log(`files: releasing the binding failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
      logServerSide('release failed', unitId, err)
      await trySetState(ctx, item, 'lock_failed', `release failed (${errorClass(err)})`)
      continue
    }
    // The binding is released. A failing bookkeeping write leaves the item `recorded`: the next pass
    // releases (a no-op) and records again, and the step fails (and is reported) meanwhile.
    if (!(await trySetState(ctx, item, 'locked'))) failures.push(unitLabel(unitId))
  }
  if (failures.length > 0) throw new KarenzPartialError(failures)
}

async function restore(ctx: KarenzContext): Promise<void> {
  const failures: string[] = []
  for (const item of await ctx.items.list(BINDING)) {
    if (RESTORE_DONE.has(item.state)) continue
    const unitId = unitOf(item)
    if (unitId === null) continue
    try {
      if ((await getOrgUnit(unitId)) === null) {
        // the unit was deleted meanwhile: nothing to bind, and the item is a fact, not a failure
        if (!(await trySetState(ctx, item, 'gone', 'the org unit no longer exists'))) failures.push(unitLabel(unitId))
        continue
      }
      const bound = wasBound(item)
      const row = await getResource(unitId, 'nextcloud')
      if (row && bound && row.external_id && row.external_id !== item.externalId) {
        // A different folder is attached now. Overwriting it would orphan that folder; the old one stays in Nextcloud.
        ctx.log(`files: ${unitLabel(unitId)} is attached to another folder, the earlier binding is not restored`)
        if (!(await trySetState(ctx, item, 'kept', 'the unit is attached to another folder'))) failures.push(unitLabel(unitId))
        continue
      }
      const attached = bound ? row?.external_id === item.externalId : row !== null
      if (!attached) {
        // One transaction: the flag, the row and its external id come together or not at all. The row is
        // written last, so an interrupted restore is simply run again.
        await getDb().begin(async (tx) => {
          await enqueueResources(tx, unitId, ['nextcloud'])
          await setSubsystemWanted(tx, unitId, 'nextcloud', true)
          if (bound) await markResourceOk(unitId, 'nextcloud', item.externalId, tx)
        })
      }
      if (!(await trySetState(ctx, item, 'restored'))) failures.push(unitLabel(unitId))
    } catch (err) {
      failures.push(unitLabel(unitId))
      ctx.log(`files: restoring the binding failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
      logServerSide('restore failed', unitId, err)
      await trySetState(ctx, item, 'unlock_failed', `re-attach failed (${errorClass(err)})`)
    }
  }
  if (failures.length > 0) throw new KarenzPartialError(failures)
}

/** The final day deletes NOTHING in Nextcloud: files are never deleted by a switch-off. Outside a preview it
 *  closes the bookkeeping (the binding stays released, the folder stays where it is). */
async function finalize(ctx: KarenzContext, opts: { dryRun: boolean }): Promise<{ deleted: Record<string, number> }> {
  if (opts.dryRun) return { deleted: {} }
  const failures: string[] = []
  for (const item of await ctx.items.list(BINDING)) {
    if (item.state !== 'locked') continue
    if (!(await trySetState(ctx, item, 'kept', 'the folder stays in Nextcloud; only the binding was released'))) {
      failures.push(unitLabel(unitOf(item)))
    }
  }
  if (failures.length > 0) throw new KarenzPartialError(failures)
  return { deleted: {} }
}

async function describe(tenant: TenantContext): Promise<{ deletes: DeletionItem[]; retained: RetainedItem[] }> {
  // The org units and the ledger resolve the tenant from the ambient context.
  return runWithTenant(tenant, describeForTenant)
}

async function describeForTenant(): Promise<{ deletes: DeletionItem[]; retained: RetainedItem[] }> {
  const units = await listOrgUnits()
  const rows = await Promise.all(units.map((unit) => getResource(unit.id, 'nextcloud')))
  const folders = rows.filter((r) => r !== null && r.external_id).length
  return {
    deletes: [],
    retained: folders > 0
      ? [{ label: 'Dateien bleiben in Nextcloud erhalten; gelöst wird nur die Verknüpfung der Gremien mit ihrem Ordner', count: folders }]
      : [],
  }
}

export const filesKarenz: KarenzParticipant = {
  catalogueId: 'files',
  switchOff,
  restore,
  finalize,
  describe,
}
