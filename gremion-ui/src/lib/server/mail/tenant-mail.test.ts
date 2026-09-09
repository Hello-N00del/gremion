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
    expect(createTransport).toHaveBeenCalledTimes(1)
    expect(createTransport.mock.calls[0][0]).toMatchObject({
      host: 'mailpit',
      port: 1025,
      secure: false,
      auth: undefined,
    })
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
    runWithTenant(DEFAULT_CTX, () => {
      getTenantMailContext()
      getTenantMailContext()
    })
    expect(createTransport).toHaveBeenCalledTimes(1)
  })

  it('cache is keyed by tenant id — A never resolves B’s transport', () => {
    runWithTenant(DEFAULT_CTX, () => getTenantMailContext())
    runWithTenant(T2_CTX, () => getTenantMailContext())
    runWithTenant(DEFAULT_CTX, () => getTenantMailContext()) // still cached
    expect(createTransport).toHaveBeenCalledTimes(2)
    expect(createTransport.mock.calls[0][0]).toMatchObject({ host: 'mailpit' })
    expect(createTransport.mock.calls[1][0]).toMatchObject({ host: 'smtp.t2.de' })
  })

  it('evictTenantMail closes the old transport and forces a rebuild', () => {
    runWithTenant(DEFAULT_CTX, () => getTenantMailContext())
    const firstTransport = createTransport.mock.results[0].value
    evictTenantMail('tid-default')
    expect(firstTransport.close).toHaveBeenCalledTimes(1)
    runWithTenant(DEFAULT_CTX, () => getTenantMailContext())
    expect(createTransport).toHaveBeenCalledTimes(2)
  })

  it('rebuilds after the cache TTL elapses', () => {
    vi.useFakeTimers()
    runWithTenant(DEFAULT_CTX, () => getTenantMailContext())
    vi.advanceTimersByTime(30_001)
    runWithTenant(DEFAULT_CTX, () => getTenantMailContext())
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
})
