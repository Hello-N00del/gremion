// PLAN-mail-transport M1 -- the deploy-time mail transport (relay | stalwart) in
// the pure provisioner code. Unit only: no env, no network.
import { describe, it, expect } from 'vitest'
import { mailTransportFromEnv, smtpServerBlock } from './realm-doc'
import { smtpServerProblems, parseMailSenderJson, type MailSender } from './reconcile'

const RELAY_ENV = {
  MAIL_TRANSPORT: 'relay',
  PLATFORM_DOMAIN: 'example.org',
  RELAY_SMTP_HOST: 'relay.example.net',
  RELAY_SMTP_PORT: '587',
  RELAY_SMTP_USER: 'relay-user@example.org',
  RELAY_SMTP_PASSWORD_REF: 'file:/run/secrets/mail/relay-password',
}
const readSecret = (ref: string): string | undefined => (ref === 'file:/run/secrets/mail/relay-password' ? 'unit-relay-pw' : undefined)

describe('mailTransportFromEnv (guard 1: fail closed, never a silent default)', () => {
  it('throws when MAIL_TRANSPORT is unset: a default to stalwart would send via a server that is not running', () => {
    const { MAIL_TRANSPORT: _m, ...rest } = RELAY_ENV
    expect(() => mailTransportFromEnv(rest, readSecret)).toThrow(/MAIL_TRANSPORT/)
    expect(() => mailTransportFromEnv({ ...rest, MAIL_TRANSPORT: '' }, readSecret)).toThrow(/MAIL_TRANSPORT/)
  })
  it('throws on a value it does not know', () => {
    expect(() => mailTransportFromEnv({ ...RELAY_ENV, MAIL_TRANSPORT: 'carrier-pigeon' }, readSecret)).toThrow(/carrier-pigeon/)
  })
  it('stalwart: needs the platform domain and nothing of the relay', () => {
    expect(mailTransportFromEnv({ MAIL_TRANSPORT: 'stalwart', PLATFORM_DOMAIN: 'example.org' }, readSecret)).toEqual({ mode: 'stalwart', domain: 'example.org' })
    expect(() => mailTransportFromEnv({ MAIL_TRANSPORT: 'stalwart' }, readSecret)).toThrow(/PLATFORM_DOMAIN/)
  })
  it('relay: resolves host, port, user, from-domain and the password FROM THE REF, never from an env value', () => {
    const t = mailTransportFromEnv({ ...RELAY_ENV, RELAY_SMTP_PASSWORD: 'inline-must-be-ignored' }, readSecret)
    expect(t).toEqual({ mode: 'relay', host: 'relay.example.net', port: 587, user: 'relay-user@example.org', password: 'unit-relay-pw', fromDomain: 'example.org' })
  })
  it('relay: RELAY_FROM_DOMAIN overrides the platform domain', () => {
    const t = mailTransportFromEnv({ ...RELAY_ENV, RELAY_FROM_DOMAIN: 'mail.example.org' }, readSecret)
    expect(t.mode === 'relay' && t.fromDomain).toBe('mail.example.org')
  })
  it.each([
    ['an empty host', { RELAY_SMTP_HOST: '' }, /RELAY_SMTP_HOST/],
    ['a port out of range', { RELAY_SMTP_PORT: '70000' }, /port/i],
    ['a non-numeric port', { RELAY_SMTP_PORT: 'abc' }, /port/i],
    ['an unresolvable password ref', { RELAY_SMTP_PASSWORD_REF: 'file:/nowhere' }, /RELAY_SMTP_PASSWORD_REF/],
    ['a user with no password ref', { RELAY_SMTP_PASSWORD_REF: '' }, /RELAY_SMTP_PASSWORD_REF/],
  ])('relay refuses %s', (_w, patch, re) => {
    expect(() => mailTransportFromEnv({ ...RELAY_ENV, ...patch }, readSecret)).toThrow(re)
  })
  it('relay with an empty user (IP-allow-listed relay) needs no password', () => {
    const t = mailTransportFromEnv({ ...RELAY_ENV, RELAY_SMTP_USER: '', RELAY_SMTP_PASSWORD_REF: '' }, readSecret)
    expect(t).toMatchObject({ mode: 'relay', user: '', password: '' })
  })
})

describe('smtpServerBlock with an empty user (IP-allow-listed relay)', () => {
  it('sends unauthenticated: auth false and neither user nor password in the block', () => {
    const b = smtpServerBlock({ host: 'relay.example.net', port: 587, from: 'no-reply@example.org', user: '', password: '' })
    expect(b.auth).toBe('false')
    expect(b).not.toHaveProperty('user')
    expect(b).not.toHaveProperty('password')
    expect(b.starttls).toBe('true')
  })
})

const RELAY: MailSender = { mode: 'relay', platformDomain: 'example.org', host: 'relay.example.net', port: 587, fromAddress: 'no-reply@example.org', user: 'relay-user@example.org' }
const STALWART: MailSender = { mode: 'stalwart', platformDomain: 'example.org', token: 'verein' }
const relayStamp = (): Record<string, string> => ({ host: 'relay.example.net', port: '587', from: 'no-reply@example.org', user: 'relay-user@example.org', auth: 'true', starttls: 'true', password: '**********' })
const stalwartStamp = (): Record<string, string> => ({ host: 'mail.example.org', port: '587', from: 'kc-verein@example.org', user: 'kc-verein@example.org', auth: 'true', starttls: 'true', password: '**********' })

describe('smtpServerProblems is mode-aware (guard 2)', () => {
  it('a clean relay stamp passes in relay mode and a clean principal stamp passes in stalwart mode', () => {
    expect(smtpServerProblems(relayStamp(), RELAY)).toEqual([])
    expect(smtpServerProblems(stalwartStamp(), STALWART)).toEqual([])
  })
  it('the legacy sender shape (no mode) is stalwart', () => {
    expect(smtpServerProblems(stalwartStamp(), { platformDomain: 'example.org', token: 'verein' })).toEqual([])
  })
  it('relay mode: a realm still stamped with its kc-<token>@ principal is named migration residue', () => {
    const p = smtpServerProblems(stalwartStamp(), RELAY)
    expect(p.join('|')).toMatch(/migration residue/)
    expect(p.join('|')).toMatch(/kc-verein@example\.org/)
  })
  it('stalwart mode: a relay-stamped realm is named migration residue', () => {
    const p = smtpServerProblems(relayStamp(), STALWART)
    expect(p.join('|')).toMatch(/migration residue/)
  })
  it('relay mode: an unresolved sentinel is a problem', () => {
    const s = relayStamp()
    s.user = '__SMTP_USER__'
    expect(smtpServerProblems(s, RELAY).join('|')).toMatch(/sentinel/)
  })
  it.each([
    ['the retired platform@ sender', (s: Record<string, string>) => { s.user = 'platform@example.org' }, /retired shared sender/],
    ['a wrong relay host', (s: Record<string, string>) => { s.host = 'mail.example.org' }, /host/],
    ['a wrong from', (s: Record<string, string>) => { s.from = 'someone@example.org' }, /from/],
    ['no password', (s: Record<string, string>) => { delete s.password }, /no password/],
    ['no STARTTLS on 587', (s: Record<string, string>) => { s.starttls = 'false' }, /starttls/],
    ['auth off with a user set', (s: Record<string, string>) => { s.auth = 'false' }, /auth/],
  ])('relay mode fails on %s', (_w, mutate, re) => {
    const s = relayStamp()
    mutate(s)
    expect(smtpServerProblems(s, RELAY).join('|')).toMatch(re)
  })
  it('relay mode with no user: unauthenticated stamp passes, an authenticating one fails', () => {
    const open: MailSender = { ...RELAY, user: '' }
    expect(smtpServerProblems({ host: 'relay.example.net', port: '587', from: 'no-reply@example.org', auth: 'false', starttls: 'true' }, open)).toEqual([])
    expect(smtpServerProblems(relayStamp(), open).join('|')).toMatch(/auth|user/)
  })
  it('relay mode on port 465 expects implicit TLS (ssl true, starttls false)', () => {
    const s465: MailSender = { ...RELAY, port: 465 }
    const ok = { ...relayStamp(), port: '465', starttls: 'false', ssl: 'true' }
    expect(smtpServerProblems(ok, s465)).toEqual([])
    expect(smtpServerProblems({ ...ok, ssl: 'false' }, s465).join('|')).toMatch(/ssl/)
  })
})

describe('parseMailSenderJson (the host hands reconcile its descriptor; the container reads no mail.env)', () => {
  it('absent -> the stalwart descriptor of this tenant (byte-identical legacy behaviour)', () => {
    expect(parseMailSenderJson(undefined, 'example.org', 'verein')).toEqual({ mode: 'stalwart', platformDomain: 'example.org', token: 'verein' })
  })
  it('relay descriptor round-trips', () => {
    const raw = JSON.stringify({ mode: 'relay', host: 'relay.example.net', port: 587, fromAddress: 'no-reply@example.org', user: 'relay-user@example.org' })
    expect(parseMailSenderJson(raw, 'example.org', 'verein')).toEqual(RELAY)
  })
  it.each([
    ['not json', '{nope', /sender/],
    ['an unknown mode', JSON.stringify({ mode: 'pigeon' }), /mode/],
    ['a relay without a host', JSON.stringify({ mode: 'relay', port: 587, fromAddress: 'a@example.org', user: '' }), /host/],
    ['a relay with a bad port', JSON.stringify({ mode: 'relay', host: 'h', port: 0, fromAddress: 'a@example.org', user: '' }), /port/],
    ['a relay carrying a password', JSON.stringify({ mode: 'relay', host: 'h', port: 587, fromAddress: 'a@example.org', user: '', password: 'x' }), /password/],
  ])('refuses %s', (_w, raw, re) => {
    expect(() => parseMailSenderJson(raw, 'example.org', 'verein')).toThrow(re)
  })
})
