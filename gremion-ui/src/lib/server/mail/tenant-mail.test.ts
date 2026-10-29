import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

// SP-2 §2 — the per-tenant mail seam. Mirrors helios-client.tenant.test.ts:
// the tenant context module is REAL; every per-tenant case uses an EXPLICIT
// runWithTenant scope (standing rule 5). nodemailer/config/secrets/registry-TTL
// are mocked so no real transport, file read, or control-DB import is pulled in.

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'mid-1' }),
      close: vi.fn(),
    })),
  },
}))

vi.mock('$lib/server/config', () => ({
  readConfig: vi.fn(),
}))

vi.mock('$lib/server/tenant/secrets', () => ({
  resolveSecret: vi.fn(() => 'resolved-pass'),
}))

// Avoid pulling the real registry (control-db / pool-registry / cycle) into the
// unit test — only the TTL constant is consumed by tenant-mail.
vi.mock('$lib/server/tenant/registry', () => ({ RESOLUTION_CACHE_TTL_MS: 30_000 }))

const guard = vi.hoisted(() => ({ resolveSmtpTarget: vi.fn(), isAllowedSmtpPort: vi.fn(() => true) }))
vi.mock('$lib/server/mail/smtp-target-guard', () => guard)

import nodemailer from 'nodemailer'
import { readConfig } from '$lib/server/config'
import { resolveSecret } from '$lib/server/tenant/secrets'
import {
  getTenantMailContext,
  sendMailForTenant,
  evictTenantMail,
  SmtpUnconfiguredError,
  _resetTenantMailForTests,
} from './tenant-mail'

const createTransport = vi.mocked(nodemailer.createTransport)

const DEFAULT_SMTP = {
  configured: true,
  host: 'mailpit',
  port: 1025,
  from_address: 'no-reply@default.de',
  from_name: 'Musterrat',
}

function ctx(id: string, slug: string, services?: TenantContext['services']): TenantContext {
  return { id, slug, services } as unknown as TenantContext
}

const SVC_CTX = ctx('tid-svc', 'svc', { smtp: { host: 'smtp.svc.de', port: 587, from: 'S <s@svc.de>' } })
const DEFAULT_CTX = ctx('tid-default', 'default') // no services.smtp ⇒ config + auth-less
const T2_CTX = ctx('tid-t2', 't2', {
  smtp: {
    host: 'smtp.t2.de',
    port: 587,
    from: 'T2 <board@t2.de>',
    user: 'smtp-user',
    passwordRef: 'file:/run/secrets/tenants/t2-smtp-pass',
  },
})

describe('tenant-mail seam (SP-2 §2)', () => {
  beforeEach(() => {
    _resetTenantMailForTests()
    createTransport.mockClear()
    vi.mocked(resolveSecret).mockClear()
    vi.mocked(readConfig).mockReturnValue({ smtp: DEFAULT_SMTP } as never)
  })
  afterEach(() => vi.useRealTimers())

  it('fail-closed: getTenantMailContext outside any tenant scope throws', () => {
    expect(() => getTenantMailContext()).toThrow(/No tenant context/)
  })

  it('default tenant (no services.smtp): config host/port, auth-less, from from config', () => {
    runWithTenant(DEFAULT_CTX, () => {
      const mail = getTenantMailContext()
      expect(mail.configured).toBe(true)
      expect(mail.from).toBe('"Musterrat" <no-reply@default.de>')
    })
    // config-derived host: no transport is built until a send (guarded facade)
    expect(createTransport).not.toHaveBeenCalled()
    expect(resolveSecret).not.toHaveBeenCalled()
  })

  it('2nd tenant: own host/port/from + auth resolved from the password ref', () => {
    runWithTenant(T2_CTX, () => {
      const mail = getTenantMailContext()
      expect(mail.from).toBe('T2 <board@t2.de>')
    })
    expect(createTransport.mock.calls[0][0]).toMatchObject({
      host: 'smtp.t2.de',
      port: 587,
      secure: false,
      auth: { user: 'smtp-user', pass: 'resolved-pass' },
    })
    expect(resolveSecret).toHaveBeenCalledWith('file:/run/secrets/tenants/t2-smtp-pass')
  })

  it('port 465 resolves to an implicit-TLS (secure) transport', () => {
    runWithTenant(
      ctx('tid-tls', 'tls', { smtp: { host: 'smtp.tls.de', port: 465, user: 'u', passwordRef: 'env:X' } }),
      () => getTenantMailContext(),
    )
    expect(createTransport.mock.calls[0][0]).toMatchObject({ port: 465, secure: true })
  })

  it('fail-closed: a passwordRef without a user throws (no auth with an undefined username)', () => {
    runWithTenant(
      ctx('tid-bad', 'bad', { smtp: { host: 'smtp.bad.de', port: 587, passwordRef: 'env:X' } }),
      () => {
        expect(() => getTenantMailContext()).toThrow(/user/i)
      },
    )
    expect(createTransport).not.toHaveBeenCalled()
  })

  it('caches the transport per tenant (two calls → one build)', () => {
    runWithTenant(SVC_CTX, () => {
      getTenantMailContext()
      getTenantMailContext()
    })
    expect(createTransport).toHaveBeenCalledTimes(1)
  })

  it('cache is keyed by tenant id — A never resolves B’s transport', () => {
    runWithTenant(SVC_CTX, () => getTenantMailContext())
    runWithTenant(T2_CTX, () => getTenantMailContext())
    runWithTenant(SVC_CTX, () => getTenantMailContext()) // still cached
    expect(createTransport).toHaveBeenCalledTimes(2)
    expect(createTransport.mock.calls[0][0]).toMatchObject({ host: 'smtp.svc.de' })
    expect(createTransport.mock.calls[1][0]).toMatchObject({ host: 'smtp.t2.de' })
  })

  it('evictTenantMail closes the old transport and forces a rebuild', () => {
    runWithTenant(SVC_CTX, () => getTenantMailContext())
    const firstTransport = createTransport.mock.results[0].value
    evictTenantMail('tid-svc')
    expect(firstTransport.close).toHaveBeenCalledTimes(1)
    runWithTenant(SVC_CTX, () => getTenantMailContext())
    expect(createTransport).toHaveBeenCalledTimes(2)
  })

  it('rebuilds after the cache TTL elapses', () => {
    vi.useFakeTimers()
    runWithTenant(SVC_CTX, () => getTenantMailContext())
    vi.advanceTimersByTime(30_001)
    runWithTenant(SVC_CTX, () => getTenantMailContext())
    expect(createTransport).toHaveBeenCalledTimes(2)
  })

  it('!configured: configured=false and sendMailForTenant throws SmtpUnconfiguredError', async () => {
    vi.mocked(readConfig).mockReturnValue({ smtp: { ...DEFAULT_SMTP, configured: false } } as never)
    await runWithTenant(DEFAULT_CTX, async () => {
      expect(getTenantMailContext().configured).toBe(false)
      await expect(
        sendMailForTenant({ to: 'x@y.de', subject: 's', html: '<p>h</p>' }),
      ).rejects.toBeInstanceOf(SmtpUnconfiguredError)
    })
  })

  it('sendMailForTenant sends through the tenant transport and returns the messageId', async () => {
    const out = await runWithTenant(T2_CTX, () =>
      sendMailForTenant({ to: 'x@y.de', subject: 's', html: '<p>h</p>' }),
    )
    expect(out).toEqual({ messageId: 'mid-1' })
    const transport = createTransport.mock.results[0].value
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'x@y.de', subject: 's', html: '<p>h</p>', from: 'T2 <board@t2.de>' }),
    )
  })

  // MED (DNS rebinding TOCTOU): a config-derived host is vetted AT SEND TIME and
  // the vetted address is dialled; the hostname only pins TLS SNI. Registry
  // overrides (services.smtp) are operator-controlled and keep dialling directly.
  describe('send-time SMTP target guard (config-derived host)', () => {
    beforeEach(() => {
      guard.resolveSmtpTarget.mockReset()
      guard.isAllowedSmtpPort.mockReset().mockReturnValue(true)
    })

    it('dials the vetted address with tls.servername = hostname', async () => {
      guard.resolveSmtpTarget.mockResolvedValue({ allowed: true, connectHost: '93.184.216.34', servername: 'mailpit' })
      await runWithTenant(DEFAULT_CTX, () => sendMailForTenant({ to: 'x@y.de', subject: 's', html: 'h' }))
      expect(guard.resolveSmtpTarget).toHaveBeenCalledWith('mailpit')
      expect(createTransport.mock.calls.at(-1)![0]).toMatchObject({
        host: '93.184.216.34',
        port: 1025,
        tls: { servername: 'mailpit' },
      })
    })

    it('fails closed when the host is no longer allowed (rebound), nothing is dialled', async () => {
      guard.resolveSmtpTarget.mockResolvedValue({ allowed: false, reason: 'blocked' })
      await expect(
        runWithTenant(DEFAULT_CTX, () => sendMailForTenant({ to: 'x@y.de', subject: 's', html: 'h' })),
      ).rejects.toThrow(/not allowed/i)
      expect(createTransport).not.toHaveBeenCalled()
    })

    it('re-checks on EVERY send, even inside the transport cache TTL', async () => {
      guard.resolveSmtpTarget.mockResolvedValueOnce({ allowed: true, connectHost: '93.184.216.34', servername: 'mailpit' })
      guard.resolveSmtpTarget.mockResolvedValueOnce({ allowed: false, reason: 'blocked' })
      await runWithTenant(DEFAULT_CTX, async () => {
        await sendMailForTenant({ to: 'x@y.de', subject: 's', html: 'h' })
        await expect(sendMailForTenant({ to: 'x@y.de', subject: 's', html: 'h' })).rejects.toThrow(/not allowed/i)
      })
      expect(guard.resolveSmtpTarget).toHaveBeenCalledTimes(2)
    })

    it('fails closed on a disallowed port', async () => {
      guard.isAllowedSmtpPort.mockReturnValue(false)
      await expect(
        runWithTenant(DEFAULT_CTX, () => sendMailForTenant({ to: 'x@y.de', subject: 's', html: 'h' })),
      ).rejects.toThrow(/not allowed/i)
    })

    it('registry override host is operator-controlled: not guarded', async () => {
      await runWithTenant(T2_CTX, () => sendMailForTenant({ to: 'x@y.de', subject: 's', html: 'h' }))
      expect(guard.resolveSmtpTarget).not.toHaveBeenCalled()
    })
  })
})
