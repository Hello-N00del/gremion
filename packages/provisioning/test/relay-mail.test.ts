// PLAN-mail-transport M1/M2 (unit half): in relay mode the host stamps the
// customer realm with the relay sender (no per-realm principal) and the SAME
// ledger step mail_principal_issued records after reading the stamp back. The
// post-condition is mode-aware; the ledger stays 8/8 (guard 3, container half).
import { describe, expect, it } from 'vitest'
import { createPhaseA, createPhaseB, ProvisioningError, recordHostStep, type CreateSpec, type MailStampExpectation } from '../src/index.ts'
import { ADMINS, deps, hostStamp, OPERATOR, PLATFORM_DOMAIN, world } from './fakes.ts'

const RELAY: MailStampExpectation = { mode: 'relay', host: 'relay.example.net', port: 587, fromAddress: `no-reply@${PLATFORM_DOMAIN}`, user: 'relay-user@example.org' }
const spec = (): CreateSpec => ({
  slug: 'musterstadt',
  host: 'rat.musterstadt.example',
  enable: [],
  operatorId: OPERATOR,
  admins: ADMINS,
})

const relayStamp = (w: ReturnType<typeof world>, realm: string, over: Partial<Record<'host' | 'port' | 'user' | 'from' | 'starttls', string | null>> = {}): void => {
  const r = w.realms.get(realm)!
  r.smtp = { host: 'relay.example.net', port: '587', user: 'relay-user@example.org', from: `no-reply@${PLATFORM_DOMAIN}`, starttls: 'true', ...over }
}

describe('relay mode: the mail step records mail_principal_issued from the relay stamp', () => {
  it('a relay-stamped realm passes the post-condition and the ledger completes 8/8 with no principal anywhere', async () => {
    const w = world()
    const d = { ...deps(w, ['calendar']), mailSender: RELAY }
    const a = await createPhaseA(spec(), d)
    relayStamp(w, a.customer.realm)
    await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d)
    await createPhaseB(spec(), d)
    const done = (await d.ledger.rows(a.customer.id)).filter((r) => r.status === 'done')
    expect(done).toHaveLength(8)
    expect(done.map((r) => r.kind)).toContain('mail_principal_issued')
    // the realm sends as the relay sender, never as kc-<token>@
    expect(w.realms.get(a.customer.realm)!.smtp.user).not.toMatch(/^kc-/)
  })

  it('an unauthenticated (IP-allow-listed) relay passes with no user in the stamp', async () => {
    const w = world()
    const d = { ...deps(w, ['calendar']), mailSender: { ...RELAY, user: '' } }
    const a = await createPhaseA(spec(), d)
    relayStamp(w, a.customer.realm, { user: null })
    await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d)
  })

  it.each([
    ['an unstamped realm', () => undefined, /host null/],
    ['the realm still carries its kc-<token>@ principal (migration residue)', (w: ReturnType<typeof world>, realm: string) => hostStamp(w, { realm, token: 'musterstadt' }), /migration residue/],
    ['a wrong relay host', (w: ReturnType<typeof world>, realm: string) => relayStamp(w, realm, { host: 'mail.example.org' }), /host/],
    ['a wrong from address', (w: ReturnType<typeof world>, realm: string) => relayStamp(w, realm, { from: 'someone@example.org' }), /from/],
    ['the retired platform@ sender', (w: ReturnType<typeof world>, realm: string) => relayStamp(w, realm, { user: `platform@${PLATFORM_DOMAIN}` }), /user/],
    ['a plaintext port', (w: ReturnType<typeof world>, realm: string) => relayStamp(w, realm, { port: '25' }), /port/],
  ])('record-step fails on %s and the step stays failed', async (_what, plant, re) => {
    const w = world()
    const d = { ...deps(w, ['calendar']), mailSender: RELAY }
    const a = await createPhaseA(spec(), d)
    plant(w, a.customer.realm)
    const err = await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProvisioningError)
    expect((err as ProvisioningError).code).toBe('POSTCONDITION')
    expect((err as ProvisioningError).message).toMatch(re)
    expect((await d.ledger.rows(a.customer.id)).filter((r) => r.kind === 'mail_principal_issued').map((r) => r.status)).toEqual(['pending', 'failed'])
  })

  it('phase B refuses a realm that is not relay-stamped (the accounts step re-asserts the stamp)', async () => {
    const w = world()
    const d = { ...deps(w, ['calendar']), mailSender: RELAY }
    const a = await createPhaseA(spec(), d)
    relayStamp(w, a.customer.realm)
    await recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d)
    relayStamp(w, a.customer.realm, { host: 'elsewhere.example.net' })
    await expect(createPhaseB(spec(), d)).rejects.toMatchObject({ code: 'POSTCONDITION' })
    expect(w.realms.get(a.customer.realm)!.users.size).toBe(0)
  })

  it('without a mailSender the stalwart expectation is unchanged: a relay-stamped realm is refused', async () => {
    const w = world()
    const d = deps(w, ['calendar'])
    const a = await createPhaseA(spec(), d)
    relayStamp(w, a.customer.realm)
    await expect(recordHostStep('musterstadt', 'mail_principal_issued', OPERATOR, d)).rejects.toMatchObject({ code: 'POSTCONDITION' })
  })
})
