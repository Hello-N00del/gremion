// TDD 2 — the permission snapshot, and the breaks that must fail it.
import { describe, expect, test } from 'vitest'
import {
  adminPermissions,
  inboxPrefixFor,
  modulePermissions,
  permissionViolations,
  SYS_RELOAD_PERMISSIONS,
  sysReloadViolations,
  type Permissions,
} from '../src/permissions.ts'

describe('module permissions (TDD 2)', () => {
  test('kernel of tenant ta: snapshot', () => {
    expect(modulePermissions('ta', 'kernel')).toEqual({
      publish: {
        allow: [
          'gremion.ta.org-unit.>',
          'gremion.ta.dlq.kernel.>',
          '$JS.API.INFO',
          '$JS.API.STREAM.INFO.ORGUNIT',
          '$JS.API.STREAM.INFO.NEWSLETTER',
          '$JS.API.CONSUMER.CREATE.NEWSLETTER',
          '$JS.API.CONSUMER.CREATE.NEWSLETTER.>',
          '$JS.API.CONSUMER.INFO.NEWSLETTER.>',
          '$JS.API.CONSUMER.DELETE.NEWSLETTER.>',
          '$JS.API.CONSUMER.MSG.NEXT.NEWSLETTER.>',
          '$JS.ACK.NEWSLETTER.>',
          '$JS.API.STREAM.INFO.CONTENT',
          '$JS.API.CONSUMER.CREATE.CONTENT',
          '$JS.API.CONSUMER.CREATE.CONTENT.>',
          '$JS.API.CONSUMER.INFO.CONTENT.>',
          '$JS.API.CONSUMER.DELETE.CONTENT.>',
          '$JS.API.CONSUMER.MSG.NEXT.CONTENT.>',
          '$JS.ACK.CONTENT.>',
          '$JS.API.STREAM.INFO.CALENDAR',
          '$JS.API.CONSUMER.CREATE.CALENDAR',
          '$JS.API.CONSUMER.CREATE.CALENDAR.>',
          '$JS.API.CONSUMER.INFO.CALENDAR.>',
          '$JS.API.CONSUMER.DELETE.CALENDAR.>',
          '$JS.API.CONSUMER.MSG.NEXT.CALENDAR.>',
          '$JS.ACK.CALENDAR.>',
        ],
        deny: [
          '$JS.API.STREAM.CREATE.>',
          '$JS.API.STREAM.UPDATE.>',
          '$JS.API.STREAM.DELETE.>',
          '$JS.API.STREAM.PURGE.>',
          '$JS.API.DIRECT.GET.>',
          '$JS.API.STREAM.MSG.GET.>',
        ],
      },
      subscribe: { allow: ['_INBOX_kernel_ta.>'], deny: ['_INBOX.>'] },
    })
  })

  test('publishing of tenant ta: owns NEWSLETTER, consumes nothing', () => {
    const p = modulePermissions('ta', 'publishing')
    expect(p.publish.allow).toEqual(['gremion.ta.newsletter.>', 'gremion.ta.dlq.publishing.>', '$JS.API.INFO', '$JS.API.STREAM.INFO.NEWSLETTER'])
    expect(p.subscribe.allow).toEqual(['_INBOX_publishing_ta.>'])
  })

  test('every current flow module passes the permission rules', () => {
    for (const m of ['kernel', 'publishing', 'content', 'calendar', 'finance']) {
      expect(permissionViolations('ta', m, modulePermissions('ta', m))).toEqual([])
    }
  })

  test('no module key can create or read the DLQ stream, or subscribe to its advisory (only the tenant admin)', () => {
    for (const m of ['kernel', 'publishing', 'content', 'calendar', 'finance']) {
      const p = modulePermissions('ta', m)
      expect(p.publish.allow, m).toContain(`gremion.ta.dlq.${m}.>`)
      expect(p.publish.allow.filter((a) => a.includes('.DLQ') || a.includes('dlq')), m).toEqual([`gremion.ta.dlq.${m}.>`])
      for (const d of ['$JS.API.STREAM.CREATE.>', '$JS.API.STREAM.DELETE.>', '$JS.API.STREAM.PURGE.>', '$JS.API.STREAM.MSG.GET.>', '$JS.API.DIRECT.GET.>']) {
        expect(p.publish.deny, m).toContain(d)
      }
      expect(p.subscribe.allow, m).toEqual([`_INBOX_${m}_ta.>`])
    }
  })

  test('the inbox prefix is per (module, tenant)', () => {
    expect(inboxPrefixFor('ta', 'finance')).toBe('_INBOX_finance_ta')
    expect(inboxPrefixFor('ta', 'finance')).not.toBe(inboxPrefixFor('tb', 'finance'))
  })

  test('a NO_BROKER or unknown module has no permissions to render', () => {
    expect(() => modulePermissions('ta', 'votes')).toThrow(/votes .*NO_BROKER/)
    expect(() => modulePermissions('ta', 'nope')).toThrow(/nope .*neither FLOWS nor NO_BROKER/)
  })

  test('an unsafe tenant id is refused', () => {
    for (const t of ['', 'A', 'a.b', 'a*', 'a>', 'a b', '-a', 'a_b']) {
      expect(() => modulePermissions(t, 'kernel'), t).toThrow(/tenant id/)
    }
  })

  const breaks: [string, (p: Permissions) => void, RegExp][] = [
    ['gremion.> publish', (p) => p.publish.allow.push('gremion.>'), /outside .*own/],
    ['gremion.<t>.> publish', (p) => p.publish.allow.push('gremion.ta.>'), /outside .*own/],
    ['STREAM.UPDATE allowed', (p) => p.publish.allow.push('$JS.API.STREAM.UPDATE.ORGUNIT'), /STREAM\.UPDATE/],
    ['shared _INBOX.>', (p) => p.subscribe.allow.push('_INBOX.>'), /inbox/],
    ['missing DIRECT.GET deny', (p) => (p.publish.deny = p.publish.deny.filter((d) => d !== '$JS.API.DIRECT.GET.>')), /DIRECT\.GET/],
    ['missing STREAM.INFO on an owned stream', (p) => (p.publish.allow = p.publish.allow.filter((a) => a !== '$JS.API.STREAM.INFO.ORGUNIT')), /STREAM\.INFO\.ORGUNIT/],
    ['a consumer grant on a stream with no flow', (p) => p.publish.allow.push('$JS.API.CONSUMER.CREATE.ORGUNIT.>'), /no consume flow/],
    ['a wildcard $JS.API grant', (p) => p.publish.allow.push('$JS.API.>'), /\$JS\.API\.>/],
    // TASK-079 G5: the dead-letter grant is exactly gremion.<t>.dlq.<module>.>
    ['another module dead-letter grant', (p) => p.publish.allow.push('gremion.ta.dlq.finance.>'), /dead-letter grant gremion\.ta\.dlq\.finance\.> is not exactly/],
    ['a tenant-wide dead-letter grant', (p) => p.publish.allow.push('gremion.ta.dlq.>'), /dead-letter grant gremion\.ta\.dlq\.> is not exactly/],
    ['a dead-letter grant under a tenant wildcard', (p) => p.publish.allow.push('gremion.*.dlq.kernel.>'), /dead-letter grant/],
    ['the dead-letter grant missing', (p) => (p.publish.allow = p.publish.allow.filter((a) => a !== 'gremion.ta.dlq.kernel.>')), /exactly one dead-letter publish grant/],
    ['the dead-letter grant twice', (p) => p.publish.allow.push('gremion.ta.dlq.kernel.>'), /exactly one dead-letter publish grant/],
  ]
  for (const [name, brk, re] of breaks) {
    test(`break: ${name} fails`, () => {
      const p = structuredClone(modulePermissions('ta', 'kernel'))
      brk(p)
      expect(permissionViolations('ta', 'kernel', p).join('\n')).toMatch(re)
    })
  }
})

describe('admin and SYS reload permissions (TDD 2)', () => {
  test('admin: JetStream API in its account, its own inbox', () => {
    expect(adminPermissions('ta')).toEqual({
      publish: { allow: ['$JS.API.>', '$JS.ACK.>'], deny: [] },
      subscribe: { allow: ['_INBOX_admin_ta.>'], deny: ['_INBOX.>'] },
    })
  })

  test('SYS reload user: PING and RELOAD only', () => {
    expect(SYS_RELOAD_PERMISSIONS).toEqual({
      publish: { allow: ['$SYS.REQ.SERVER.PING', '$SYS.REQ.SERVER.*.RELOAD'], deny: [] },
      subscribe: { allow: ['_INBOX_sysreload.>'], deny: [] },
    })
    expect(sysReloadViolations(SYS_RELOAD_PERMISSIONS)).toEqual([])
  })

  for (const extra of ['>', '$SYS.>', '$SYS.REQ.SERVER.*.KICK', '$SYS.REQ.ACCOUNT.*.CONNZ', '$SYS.REQ.SERVER.*.CONNZ']) {
    test(`break: SYS reload given ${extra} fails`, () => {
      const p = structuredClone(SYS_RELOAD_PERMISSIONS) as Permissions
      p.publish.allow.push(extra)
      expect(sysReloadViolations(p).join('\n')).toMatch(/SYS reload/)
    })
  }
})
