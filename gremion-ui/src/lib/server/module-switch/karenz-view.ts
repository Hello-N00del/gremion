// src/lib/server/module-switch/karenz-view.ts
// Module Karenz (phase 2, Task 17): the settings page's view of ONE live Karenz row.
//
// Read-only. The platform row is the clock (days left, whether switching on is still the restore); the
// tenant step ledger, the item list and the notice counts say how far the per-tenant pass got and what
// went wrong; the sealed copies of the module are the downloads. Nothing here can name a person:
//   - the platform row the pass reads (listKarenz) has no actor column, and this view copies named fields;
//   - the notice counts are numbers, the skipped holders are a number;
//   - problems carry the step name, the error CLASS the pass recorded (never a message) and item ids.
// A read that fails never turns into "all well": it becomes a problem line of its own.
import type { Sql } from '@gremion/db'
import type { KarenzView } from '$lib/modules/switch-preview'
import type { KarenzRowView } from '$lib/server/module-karenz/platform'
import type { KarenzItemRow, NoticeKind, StepRow } from '$lib/server/module-karenz/store'
import { listItems, listSteps, noticeCounts } from '$lib/server/module-karenz/store'
import type { TenantContext } from '$lib/server/tenant/context'

/**
 * The Karenz length in days. A mirror of KARENZ_DAYS in @gremion/tenant-store/lifecycle, which this
 * browser-facing module must not import (it pulls the database drivers); the unit test pins them equal.
 */
export const GRACE_DAYS = 30

/** The backup export page of the settings (the files module being off never hides it). */
export const BACKUP_HREF = '/settings/sicherungen'

const DAY_MS = 24 * 60 * 60 * 1000
const STEP_NOTICE = 'notice:switchoff'

/** The listing the view needs of a sealed copy (a subset of serve.ts RetainedListing). */
export interface RetainedCopy {
  id: string
  catalogueId: string
  retentionClass: string
  lineCount: number
}

export interface KarenzViewDeps {
  listSteps(db: Sql, karenzId: string): Promise<StepRow[]>
  listItems(db: Sql, karenzId: string): Promise<KarenzItemRow[]>
  noticeCounts(db: Sql, karenzId: string, kind: NoticeKind): Promise<{ sent: number; failed: number }>
  listRetained(tenantId: string, db: Sql): Promise<RetainedCopy[]>
  /** How many holders of the notified roles cannot be mailed right now (no address, disabled). */
  skippedHolders(tenant: TenantContext): Promise<number>
  now(): Date
}

function defaults(): KarenzViewDeps {
  return {
    listSteps,
    listItems,
    noticeCounts,
    // lazy: these pull the erasure orchestrator and the Keycloak admin client, which the callers that only
    // need the constants of this file must not load
    listRetained: async (tenantId, db) => (await import('$lib/server/module-karenz/retained/serve')).listRetained(tenantId, db),
    skippedHolders: async (tenant) => (await (await import('$lib/server/governance/role-holders')).listRoleHolders(tenant)).skipped.length,
    now: () => new Date(),
  }
}

/** What each retention class is called for a council, and on which period it is kept. Anything else is named by its class id. */
const CLASSES: Readonly<Record<string, { label: string; basis: string }>> = Object.freeze({
  'RC-GOV-RES': { label: 'Beschlüsse und Abstimmungsergebnisse (schreibgeschützte Kopie)', basis: 'Protokollfrist' },
  'RC-ELE': { label: 'Wahlergebnisse (schreibgeschützte Kopie)', basis: 'Protokollfrist' },
  'RC-HND-TRACK': { label: 'Übergabeunterlagen (schreibgeschützte Kopie)', basis: '2 Jahre nach Ende der Amtszeit' },
})

export function retainedLabel(retentionClass: string): string {
  return CLASSES[retentionClass]?.label ?? `Aufbewahrte Unterlagen (${retentionClass})`
}

export function retainedBasis(retentionClass: string): string {
  return CLASSES[retentionClass]?.basis ?? retentionClass
}

const READ_FAILED = {
  steps: 'Der Stand der Abwicklung konnte nicht gelesen werden.',
  items: 'Der Stand der gesperrten Einträge konnte nicht gelesen werden.',
  retained: 'Die aufbewahrten Unterlagen konnten nicht aufgelistet werden.',
} as const

function logRead(tenant: TenantContext, what: string, err: unknown): void {
  console.error(`[module-switch] ${tenant.slug}: the Karenz view could not read ${what}:`, err instanceof Error ? err.message : err)
}

/** Whole days until `finalAt`, rounded up and never below zero. */
function daysUntil(finalAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((finalAt.getTime() - now.getTime()) / DAY_MS))
}

export async function buildKarenzView(tenant: TenantContext, row: KarenzRowView, deps: Partial<KarenzViewDeps> = {}): Promise<KarenzView> {
  const d = { ...defaults(), ...deps }
  const problems: string[] = []

  let steps: StepRow[] = []
  try {
    steps = await d.listSteps(tenant.db, row.karenzId)
  } catch (err) {
    logRead(tenant, 'the step ledger', err)
    problems.push(READ_FAILED.steps)
  }
  for (const s of steps) {
    if (s.state === 'failed') problems.push(`Schritt ${s.step} fehlgeschlagen: ${s.lastError ?? 'ohne Angabe'}`)
  }

  try {
    for (const i of await d.listItems(tenant.db, row.karenzId)) {
      if (i.state === 'lock_failed') problems.push(`${i.kind} ${i.externalId}: Sperre abgelehnt`)
      else if (i.state === 'unlock_failed') problems.push(`${i.kind} ${i.externalId}: Freigabe abgelehnt`)
    }
  } catch (err) {
    logRead(tenant, 'the item list', err)
    problems.push(READ_FAILED.items)
  }

  const noticeStep = steps.find((s) => s.step === STEP_NOTICE)
  const mailFailed = noticeStep?.state === 'failed'
  let mail: KarenzView['mail'] = null
  if (noticeStep?.state === 'done') {
    try {
      const counts = await d.noticeCounts(tenant.db, row.karenzId, 'switchoff')
      let skippedHolders = 0
      try {
        skippedHolders = await d.skippedHolders(tenant)
      } catch (err) {
        // the holders are a live lookup in the council's identity service; its outage must not hide the rest
        logRead(tenant, 'the role holders', err)
      }
      mail = { recipients: counts.sent, failed: counts.failed, skippedHolders }
    } catch (err) {
      logRead(tenant, 'the notice counts', err)
      problems.push(READ_FAILED.steps)
    }
  }

  let retained: KarenzView['retained'] = []
  try {
    retained = (await d.listRetained(tenant.id, tenant.db))
      .filter((r) => r.catalogueId === row.catalogueId)
      .map((r) => ({ id: r.id, label: retainedLabel(r.retentionClass), lineCount: r.lineCount, href: `/api/settings/modules/retained?id=${encodeURIComponent(r.id)}` }))
  } catch (err) {
    logRead(tenant, 'the sealed copies', err)
    problems.push(READ_FAILED.retained)
  }

  return {
    karenzId: row.karenzId,
    state: row.state,
    switchedOffAt: row.switchedOffAt.toISOString(),
    finalAt: row.finalAt.toISOString(),
    daysLeft: daysUntil(row.finalAt, d.now()),
    canRestore: row.state === 'open',
    mail,
    mailFailed,
    problems: [...new Set(problems)],
    retained,
    backupHref: BACKUP_HREF,
  }
}
