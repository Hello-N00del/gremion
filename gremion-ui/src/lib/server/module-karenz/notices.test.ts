// @vitest-environment node
//
// Module Karenz (phase 2, Task 9): sending the info mail and the reminders. The role lookup, the mail
// seam and the notice ledger are doubles; sendKarenzNotice is the real one. Review Focus 4: nobody can
// be told - the switch-off stays in force, the step fails loudly and is retried, nothing is half sent.
import { describe, expect, it, vi } from 'vitest'
import type { TenantContext } from '$lib/server/tenant/context'
import { SmtpUnconfiguredError } from '$lib/server/mail/tenant-mail'
import type { RoleHolder, RoleHolders } from '$lib/server/governance/role-holders'
import type { NoticeInput, NoticeKind } from './store'
import type { KarenzRowView } from './platform'
import { KarenzNoticeError, sendKarenzNotice, type NoticeDeps } from './notices'

const DAY = 24 * 3_600_000
const T0 = new Date('2026-11-01T10:00:00Z')
const KARENZ = '44444444-4444-4444-8444-444444444441'
const tenant = { id: '11111111-1111-4111-8111-111111111111', slug: 'rat-a', db: { tenantDb: true }, primaryHost: 'rat.example.test' } as unknown as TenantContext
const row = { karenzId: KARENZ, catalogueId: 'votes', switchedOffAt: T0, finalAt: new Date(T0.getTime() + 30 * DAY) } as unknown as KarenzRowView
const ctx = { tenant, row, moduleLabel: 'Abstimmungen' }

const holder = (n: number, over: Partial<RoleHolder> = {}): RoleHolder => ({
  userId: `user-${n}`,
  email: `person${n}@rat.example.test`,
  displayName: `Person ${n}`,
  roles: ['council-admin'],
  ...over,
})

interface Rig {
  sent: Array<{ to: string; subject: string; html: string; extra: string[] }>
  ledger: Array<NoticeInput>
  now: Date
  holders: RoleHolders
  failSendTo: Set<string>
  smtpUnconfigured: boolean
  keycloakDown: boolean
  deps: NoticeDeps
}

function rig(holders: RoleHolders): Rig {
  const r = { sent: [], ledger: [], now: new Date(T0.getTime() + 1000), holders, failSendTo: new Set(), smtpUnconfigured: false, keycloakDown: false } as unknown as Rig
  r.deps = {
    listRoleHolders: async () => {
      if (r.keycloakDown) throw new Error('keycloak 503')
      return r.holders
    },
    send: async (_tenant, msg) => {
      if (r.smtpUnconfigured) throw new SmtpUnconfiguredError('t')
      if (r.failSendTo.has(msg.to)) throw new Error(`550 mailbox ${msg.to} unavailable`)
      // a second address field would be a shared To/Cc: the seam has none, so it is checked on the message
      r.sent.push({ to: msg.to, subject: msg.subject, html: msg.html, extra: Object.keys(msg).filter((k) => !['to', 'subject', 'html'].includes(k)) })
      return { messageId: 'm' }
    },
    noticesSent: async (_db, karenzId, kind: NoticeKind) =>
      new Set(r.ledger.filter((n) => n.karenzId === karenzId && n.kind === kind && n.state === 'sent').map((n) => n.userId)),
    recordNotice: async (_db, n) => {
      r.ledger.push(n)
    },
    now: () => r.now,
    settingsUrl: () => 'https://rat.example.test/settings/module',
  }
  return r
}

describe('sendKarenzNotice', () => {
  it('sends one mail per holder, none with a shared To or Cc, and records each as sent', async () => {
    const r = rig({ holders: [holder(1), holder(2), holder(3, { roles: ['council-admin', 'vorstand'] })], skipped: [] })
    const out = await sendKarenzNotice(ctx, 'switchoff', r.deps)
    expect(out).toEqual({ sent: 3, failed: 0, skipped: [] })
    expect(r.sent.map((m) => m.to)).toEqual(['person1@rat.example.test', 'person2@rat.example.test', 'person3@rat.example.test'])
    for (const m of r.sent) {
      expect(m.to).not.toMatch(/[,;]/)
      expect(m.extra).toEqual([])
    }
    expect(r.ledger.map((n) => [n.userId, n.state, n.kind])).toEqual([
      ['user-1', 'sent', 'switchoff'],
      ['user-2', 'sent', 'switchoff'],
      ['user-3', 'sent', 'switchoff'],
    ])
    // the content is the rendered mail: module, final date, link
    expect(r.sent[0]!.html).toContain('Abstimmungen')
    expect(r.sent[0]!.html).toContain('1. Dezember 2026')
    expect(r.sent[0]!.html).toContain('https://rat.example.test/settings/module')
  })

  it('a second call after a partial failure mails only the holders not yet sent', async () => {
    const r = rig({ holders: [holder(1), holder(2), holder(3)], skipped: [] })
    r.failSendTo.add('person2@rat.example.test')
    await expect(sendKarenzNotice(ctx, 'switchoff', r.deps)).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(r.sent.map((m) => m.to)).toEqual(['person1@rat.example.test', 'person3@rat.example.test'])
    const failed = r.ledger.find((n) => n.state === 'failed')!
    expect(failed.userId).toBe('user-2')
    // the stored reason carries no address and no server text: the class only
    expect(failed.error).not.toContain('person2@')
    expect(failed.error).not.toContain('550')

    r.failSendTo.clear()
    r.sent.length = 0
    const out = await sendKarenzNotice(ctx, 'switchoff', r.deps)
    expect(out).toEqual({ sent: 1, failed: 0, skipped: [] })
    expect(r.sent.map((m) => m.to)).toEqual(['person2@rat.example.test'])
  })

  it('empty holders throws NO_RECIPIENTS and lists who was skipped (Review Focus 4)', async () => {
    const r = rig({ holders: [], skipped: [{ userId: 'user-9', reason: 'no-email' }] })
    const err = await sendKarenzNotice(ctx, 'switchoff', r.deps).catch((e) => e)
    expect(err).toBeInstanceOf(KarenzNoticeError)
    expect(err.code).toBe('NO_RECIPIENTS')
    expect(err.skipped).toEqual([{ userId: 'user-9', reason: 'no-email' }])
    expect(r.sent).toEqual([])
    expect(r.ledger).toEqual([])
    // the name is what the engine reports (the class only): it must say which of the codes it was
    expect(err.name).toBe('KarenzNoticeError_NO_RECIPIENTS')
  })

  it('SmtpUnconfiguredError throws SMTP_UNCONFIGURED and nothing is recorded as sent', async () => {
    const r = rig({ holders: [holder(1), holder(2)], skipped: [] })
    r.smtpUnconfigured = true
    await expect(sendKarenzNotice(ctx, 'switchoff', r.deps)).rejects.toMatchObject({ code: 'SMTP_UNCONFIGURED' })
    expect(r.ledger.filter((n) => n.state === 'sent')).toEqual([])
    // it stops at the first one: the same cause would only repeat for the second
    expect(r.sent).toEqual([])
  })

  it('a Keycloak failure from listRoleHolders aborts the notice: no partial list, nothing sent or recorded', async () => {
    const r = rig({ holders: [holder(1)], skipped: [] })
    r.keycloakDown = true
    await expect(sendKarenzNotice(ctx, 'switchoff', r.deps)).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(r.sent).toEqual([])
    expect(r.ledger).toEqual([])
  })

  it('returns the skipped holders (disabled, no e-mail) for the settings page', async () => {
    const skipped: RoleHolders['skipped'] = [
      { userId: 'user-7', reason: 'disabled' },
      { userId: 'user-8', reason: 'no-email' },
    ]
    const r = rig({ holders: [holder(1)], skipped })
    expect(await sendKarenzNotice(ctx, 'switchoff', r.deps)).toEqual({ sent: 1, failed: 0, skipped })
  })

  it('a reminder due after finalAt is not sent: it throws TOO_LATE, which the engine reports as an ERROR event of the step', async () => {
    for (const kind of ['t23', 't29'] as const) {
      const r = rig({ holders: [holder(1)], skipped: [] })
      r.now = new Date(row.finalAt.getTime() + 1000)
      const err = await sendKarenzNotice(ctx, kind, r.deps).catch((e) => e)
      expect(err, kind).toBeInstanceOf(KarenzNoticeError)
      expect(err.code, kind).toBe('TOO_LATE')
      expect(r.sent, kind).toEqual([])
    }
  })

  it('a pass that was down for 5 days sends t23 late but before finalAt, and t29 on time', async () => {
    const r = rig({ holders: [holder(1)], skipped: [] })
    // t23 was due on day 23; the pass wakes on day 28
    r.now = new Date(T0.getTime() + 28 * DAY)
    expect(await sendKarenzNotice(ctx, 't23', r.deps)).toMatchObject({ sent: 1, failed: 0 })
    // t29 is due on day 29 and goes out then
    r.now = new Date(T0.getTime() + 29 * DAY + 60_000)
    expect(await sendKarenzNotice(ctx, 't29', r.deps)).toMatchObject({ sent: 1, failed: 0 })
    expect(r.ledger.map((n) => n.kind)).toEqual(['t23', 't29'])
    // each kind has its own ledger: t23 having been sent does not suppress t29
    expect(r.sent).toHaveLength(2)
  })

  it('the mail path never reads the actor: the audit entry carries it, this module has no access to module_switch_request', async () => {
    const r = rig({ holders: [holder(1)], skipped: [] })
    const spy = vi.fn()
    // the only inputs are the tenant, the row (no actor field) and the label
    expect(Object.keys(row)).not.toContain('actorUserId')
    await sendKarenzNotice(ctx, 'switchoff', { ...r.deps, now: () => (spy(), r.now) })
    const html = r.sent[0]!.html
    expect(html).not.toMatch(/ausgeschaltet von|switched off by/i)
    // the source of the module does not import the switch-request store
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    for (const f of ['./notices.ts', './mail.ts']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')
      expect(src, f).not.toMatch(/module-switch\/store|listSwitches|actorUserId|actor_user_id/)
    }
  })

  it('refuses to send when the tenant has no canonical host: there is no link to put in the mail', async () => {
    const r = rig({ holders: [holder(1)], skipped: [] })
    const { settingsUrl: _unused, ...rest } = r.deps
    const noHost = { ...ctx, tenant: { ...tenant, primaryHost: null } as unknown as TenantContext }
    await expect(sendKarenzNotice(noHost, 'switchoff', rest)).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
    expect(r.sent).toEqual([])
  })
})
