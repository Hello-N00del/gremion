// src/lib/server/module-karenz/notices.ts
// Module Karenz (phase 2, Task 9): who is told, and the sending.
//
// The info mail at switch-off and the two reminders (day 23 and day 29) go to the holders of the realm
// roles in NOTIFY_ROLES (council-admin, vorstand), de-duplicated, ONE mail per person: no shared To or
// Cc, so nobody sees who else was told. The recipients come from Keycloak (listRoleHolders), never from
// a local table.
//
// The actor is not an input here. This module reads neither module_switch_request nor the audit log, and
// KarenzMailInput has no field for a person: the mail cannot name who switched the module off.
//
// Failure is loud, never silent (Review Focus 4). Nobody to tell, no SMTP, a Keycloak outage or a
// refused delivery all THROW a KarenzNoticeError; the engine records the step as failed, reports the
// error class (the name carries the code: KarenzNoticeError_NO_RECIPIENTS ...) and retries on the next
// pass. A holder already mailed is never mailed again (the notice ledger, per karenz, kind and user), so
// a retry after a partial failure only reaches the holders that are left.
import { listRoleHolders as realListRoleHolders, type RoleHolders } from '$lib/server/governance/role-holders'
import { SmtpUnconfiguredError, sendMailForTenant } from '$lib/server/mail/tenant-mail'
import { safeFailureReason } from '$lib/server/erasure/orchestrator'
import { MODULE_MANIFESTS } from '$lib/modules/manifests'
import { TOGGLEABLE_PAIRS } from '$lib/modules/catalogue-map'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import type { Sql } from '@gremion/db'
import type { KarenzContext } from './participants'
import type { KarenzRowView } from './platform'
import { renderKarenzMail, type NoticeKind } from './mail'
import * as realStore from './store'
import type { NoticeInput } from './store'

export type { NoticeKind }

export type NoticeErrorCode = 'NO_RECIPIENTS' | 'SMTP_UNCONFIGURED' | 'DELIVERY_FAILED' | 'TOO_LATE'

/**
 * Why a notice step failed. The `name` carries the code because the engine reports the error class and
 * nothing else to the platform (external messages hold addresses): KarenzNoticeError_NO_RECIPIENTS.
 * `skipped` lists the role holders who could not be mailed (the settings page of Task 17 is its reader;
 * nothing persists it yet). `cause` keeps the underlying error for the server log; only the class
 * reaches the platform.
 */
export class KarenzNoticeError extends Error {
  constructor(
    readonly code: NoticeErrorCode,
    message: string,
    readonly skipped: RoleHolders['skipped'] = [],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = `KarenzNoticeError_${code}`
  }
}

/** The part of a platform row the notice needs. A full KarenzRowView fits; the actor is not in it. */
export type NoticeRow = Pick<KarenzRowView, 'karenzId' | 'catalogueId' | 'switchedOffAt' | 'finalAt'>

export interface NoticeDeps {
  listRoleHolders: (tenant: TenantContext) => Promise<RoleHolders>
  /** One message to ONE address. The seam has no second address field. */
  send: (tenant: TenantContext, msg: { to: string; subject: string; html: string }) => Promise<unknown>
  noticesSent: (db: Sql, karenzId: string, kind: NoticeKind) => Promise<Set<string>>
  recordNotice: (db: Sql, n: NoticeInput) => Promise<void>
  now: () => Date
  /** The absolute link to the settings page; throws when the tenant has no canonical host. */
  settingsUrl: (tenant: TenantContext) => string
}

/** The settings section where a module is switched on again (routes/settings/[section]: `module`). */
const SETTINGS_PATH = '/settings/module'

function defaultSettingsUrl(tenant: TenantContext): string {
  // primaryHost null is a reject signal for every consumer, never a cue to invent <slug>.<apex>
  if (!tenant.primaryHost) throw new KarenzNoticeError('DELIVERY_FAILED', `tenant ${tenant.slug} has no canonical host, so the mail has no settings link`)
  return `https://${tenant.primaryHost}${SETTINGS_PATH}`
}

function defaults(): NoticeDeps {
  return {
    listRoleHolders: (tenant) => realListRoleHolders(tenant),
    // sendMailForTenant reads the tenant from the async context: bind it, whatever scope the pass runs in
    send: (tenant, msg) => runWithTenant(tenant, () => sendMailForTenant(msg)),
    noticesSent: realStore.noticesSent,
    recordNotice: realStore.recordNotice,
    now: () => new Date(),
    settingsUrl: defaultSettingsUrl,
  }
}

/**
 * Mail every holder who has not been mailed for this (row, kind) yet.
 *
 * - No deliverable holder: NO_RECIPIENTS (with the skipped list), nothing sent.
 * - Keycloak down: DELIVERY_FAILED, nothing sent, no partial list.
 * - SMTP not configured: SMTP_UNCONFIGURED at the first message, nothing recorded as sent.
 * - A refused delivery to one holder is recorded failed and the others are still mailed; the call then
 *   throws DELIVERY_FAILED so the step is retried and only the holders left are tried again.
 * - A reminder at or after the final day: TOO_LATE, nothing sent (the engine reports it as an error of
 *   the step; a "your data is deleted tomorrow" mail after the deletion would be false).
 *
 * Delivery is at-least-once: when the ledger write after a successful send fails, the error propagates,
 * the step is retried and that holder is mailed again. For a failsafe notice that is the right side to
 * err on; a lost mail is not.
 *
 * `sent` counts the mails of this call, `alreadySent` the holders an earlier call had reached.
 */
export async function sendKarenzNotice(
  ctx: { tenant: TenantContext; row: NoticeRow; moduleLabel: string },
  kind: NoticeKind,
  deps: Partial<NoticeDeps> = {},
): Promise<{ sent: number; failed: number; alreadySent: number; skipped: RoleHolders['skipped'] }> {
  const d = { ...defaults(), ...deps }
  const { tenant, row } = ctx
  if (kind !== 'switchoff' && d.now().getTime() >= row.finalAt.getTime()) {
    throw new KarenzNoticeError('TOO_LATE', `the ${kind} reminder was not sent before the final day`)
  }

  let people: RoleHolders
  try {
    people = await d.listRoleHolders(tenant)
  } catch (err) {
    // the cause stays in the log; the step records the class only
    console.error(`[module-karenz] ${tenant.slug}: the role lookup for the ${kind} notice failed:`, err)
    throw new KarenzNoticeError('DELIVERY_FAILED', 'the role holders could not be read', [], { cause: err })
  }
  if (people.holders.length === 0) {
    throw new KarenzNoticeError('NO_RECIPIENTS', 'no admin or Vorstand member can be mailed (none exists, or all are disabled or without an e-mail address)', people.skipped)
  }

  const settingsUrl = d.settingsUrl(tenant)
  const { subject, html } = renderKarenzMail({
    moduleLabel: ctx.moduleLabel,
    switchedOffAt: row.switchedOffAt,
    finalAt: row.finalAt,
    kind,
    settingsUrl,
  })

  const already = await d.noticesSent(tenant.db, row.karenzId, kind)
  let sent = 0
  let failed = 0
  // holders reached by an earlier call (a retry after a partial failure): counted so the summary shows the whole reach
  let alreadySent = 0
  for (const h of people.holders) {
    if (already.has(h.userId)) {
      alreadySent++
      continue
    }
    try {
      await d.send(tenant, { to: h.email, subject, html })
    } catch (err) {
      if (err instanceof SmtpUnconfiguredError) throw new KarenzNoticeError('SMTP_UNCONFIGURED', 'the tenant has no SMTP configuration', people.skipped)
      failed++
      console.error(`[module-karenz] ${tenant.slug}: the ${kind} mail to user ${h.userId} failed:`, err)
      // the stored reason is the class only: an SMTP answer holds the address
      await d.recordNotice(tenant.db, { karenzId: row.karenzId, kind, userId: h.userId, state: 'failed', error: safeFailureReason(err) })
      continue
    }
    await d.recordNotice(tenant.db, { karenzId: row.karenzId, kind, userId: h.userId, state: 'sent' })
    sent++
  }
  if (failed > 0) {
    throw new KarenzNoticeError('DELIVERY_FAILED', `${failed} of ${people.holders.length} mail(s) could not be delivered (${sent} sent in this call)`, people.skipped)
  }
  return { sent, failed, alreadySent, skipped: people.skipped }
}

/**
 * What the council calls a module: the label its own manifest declares. The messaging module's catalogue
 * id differs from its manifest id; a module without a label falls back to its catalogue id (the pass
 * must never fail to mail because a label is missing).
 */
export function moduleLabelOf(catalogueId: string): string {
  const pair = TOGGLEABLE_PAIRS.find((p) => p.catalogueId === catalogueId)
  if (pair) return pair.label
  const manifestId = catalogueId === 'messaging' ? 'messages' : catalogueId
  return MODULE_MANIFESTS.find((m) => m.id === manifestId)?.status?.label ?? catalogueId
}

/** The one-line result the engine reports as the info event of the step. Counts only, no person. */
function summary(r: { sent: number; alreadySent: number; skipped: RoleHolders['skipped'] }): string {
  // the whole reach, not only this call's mails: a retried step must not tell the platform "sent 1" when 3 were told
  return `sent ${r.sent + r.alreadySent}, skipped ${r.skipped.length}`
}

/**
 * The notice stages the engine runs: `noticeSwitchoff` (first of all steps after `started`, so a stuck
 * external system cannot suppress the failsafe mail) and `reminder` (day 23 and day 29, run when due).
 */
export function createNoticeStages(deps: Partial<NoticeDeps> = {}): {
  noticeSwitchoff: (ctx: KarenzContext) => Promise<string>
  reminder: (ctx: KarenzContext, kind: 't23' | 't29') => Promise<string>
} {
  const run = async (ctx: KarenzContext, kind: NoticeKind): Promise<string> =>
    summary(
      await sendKarenzNotice(
        {
          tenant: ctx.tenant,
          row: { karenzId: ctx.karenzId, catalogueId: ctx.catalogueId, switchedOffAt: ctx.switchedOffAt, finalAt: ctx.finalAt },
          moduleLabel: moduleLabelOf(ctx.catalogueId),
        },
        kind,
        deps,
      ),
    )
  return {
    noticeSwitchoff: (ctx) => run(ctx, 'switchoff'),
    reminder: (ctx, kind) => run(ctx, kind),
  }
}
