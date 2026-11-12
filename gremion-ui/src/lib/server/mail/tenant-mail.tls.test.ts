// @vitest-environment node
// The tenant mail transport on the wire: the REAL nodemailer against a small
// SMTP server on the loopback that records every line it is sent. An option
// shape cannot show what leaves the socket, so these cases read the socket.
import { createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

vi.mock('$lib/server/config', () => ({ readConfig: vi.fn() }))
vi.mock('$lib/server/tenant/secrets', () => ({ resolveSecret: vi.fn(() => 'the-relay-password') }))
vi.mock('$lib/server/tenant/registry', () => ({ RESOLUTION_CACHE_TTL_MS: 30_000 }))
const guard = vi.hoisted(() => ({ resolveSmtpTarget: vi.fn(), isAllowedSmtpPort: vi.fn(() => true) }))
vi.mock('$lib/server/mail/smtp-target-guard', () => guard)

import { readConfig } from '$lib/server/config'
import { sendMailForTenant, _resetTenantMailForTests } from './tenant-mail'

interface FakeSmtp {
  port: number
  /** Every command line the client sent, in order (message body lines excluded). */
  lines: string[]
  close(): Promise<void>
}

/**
 * A plaintext SMTP server that never offers STARTTLS and refuses it when asked,
 * the shape a session has after the capability was removed on the path. It
 * accepts any AUTH, so a client that logs in without the upgrade is seen to do so.
 */
function startPlaintextSmtp(): Promise<FakeSmtp> {
  const lines: string[] = []
  const server: Server = createServer((socket) => {
    let buffer = ''
    let inData = false
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.write('220 fake ESMTP\r\n')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\r\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 2)
        nl = buffer.indexOf('\r\n')
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 queued\r\n')
          }
          continue
        }
        lines.push(line)
        const verb = line.split(' ')[0].toUpperCase()
        if (verb === 'EHLO') socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n')
        else if (verb === 'STARTTLS') socket.write('454 TLS not available\r\n')
        else if (verb === 'AUTH') socket.write('235 authenticated\r\n')
        else if (verb === 'DATA') {
          inData = true
          socket.write('354 go ahead\r\n')
        } else if (verb === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        lines,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

function tenant(id: string, smtp?: NonNullable<TenantContext['services']>['smtp']): TenantContext {
  return { id, slug: id, services: smtp ? { smtp } : undefined } as unknown as TenantContext
}

const MESSAGE = { to: 'someone@example.org', subject: 's', html: '<p>h</p>' }
const verbs = (smtp: FakeSmtp) => smtp.lines.map((l) => l.split(' ')[0].toUpperCase())

describe('tenant mail on the wire: a login needs an encrypted session', () => {
  let smtp: FakeSmtp

  beforeEach(async () => {
    _resetTenantMailForTests()
    guard.resolveSmtpTarget.mockReset()
    guard.isAllowedSmtpPort.mockReset().mockReturnValue(true)
    smtp = await startPlaintextSmtp()
  })
  afterEach(async () => {
    await smtp.close()
  })

  it('registry relay with a login: no AUTH line is sent when STARTTLS is not available', async () => {
    vi.mocked(readConfig).mockReturnValue({
      smtp: { configured: true, host: 'unused.example.org', port: 587, from_address: 'rat@example.org' },
    } as never)
    const t = tenant('tid-relay', {
      host: '127.0.0.1',
      port: smtp.port,
      from: 'rat@example.org',
      user: 'relay-user',
      passwordRef: 'file:/run/secrets/tenants/relay-smtp-password',
    })

    await expect(runWithTenant(t, () => sendMailForTenant(MESSAGE))).rejects.toThrow()

    expect(verbs(smtp)).toContain('STARTTLS')
    expect(verbs(smtp)).not.toContain('AUTH')
    expect(verbs(smtp)).not.toContain('MAIL')
  })

  it('registry login on the host from the settings: no AUTH line is sent when STARTTLS is not available', async () => {
    vi.mocked(readConfig).mockReturnValue({
      smtp: { configured: true, host: 'mail.example.org', port: smtp.port, from_address: 'rat@example.org' },
    } as never)
    guard.resolveSmtpTarget.mockResolvedValue({ allowed: true, connectHost: '127.0.0.1' })
    const t = tenant('tid-settings-host', {
      user: 'relay-user',
      passwordRef: 'file:/run/secrets/tenants/relay-smtp-password',
    })

    await expect(runWithTenant(t, () => sendMailForTenant(MESSAGE))).rejects.toThrow()

    expect(guard.resolveSmtpTarget).toHaveBeenCalledWith('mail.example.org')
    expect(verbs(smtp)).toContain('STARTTLS')
    expect(verbs(smtp)).not.toContain('AUTH')
    expect(verbs(smtp)).not.toContain('MAIL')
  })

  it('no login attached (the local mail catcher): the message is still handed over in plaintext', async () => {
    vi.mocked(readConfig).mockReturnValue({
      smtp: { configured: true, host: 'mailpit', port: smtp.port, from_address: 'rat@example.org' },
    } as never)
    guard.resolveSmtpTarget.mockResolvedValue({ allowed: true, connectHost: '127.0.0.1' })

    const out = await runWithTenant(tenant('tid-catcher'), () => sendMailForTenant(MESSAGE))

    expect(out.messageId).toEqual(expect.any(String))
    expect(verbs(smtp)).not.toContain('AUTH')
    expect(verbs(smtp)).toEqual(expect.arrayContaining(['MAIL', 'RCPT', 'DATA']))
  })
})
