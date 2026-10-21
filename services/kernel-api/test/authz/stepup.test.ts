// TRD-090 freshness rules, DB-free; plus catalogue invariants.
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, ROLES, roleDef } from '../../src/authz/catalogue.ts'
import { checkStepUp } from '../../src/authz/stepup.ts'

const NOW = 1_800_000_000

describe('checkStepUp', () => {
  it('accepts loa2 with auth_time inside 300 s (the product request: acr_values loa2, max_age 300)', () => {
    expect(checkStepUp({ acr: 'loa2', auth_time: NOW - 299 }, NOW)).toEqual({ ok: true })
    expect(checkStepUp({ acr: 'loa3', auth_time: NOW - 1 }, NOW)).toEqual({ ok: true })
  })
  it('refuses a low acr, a missing or non-numeric auth_time, and a stale or future one', () => {
    expect(checkStepUp({ acr: 'loa1', auth_time: NOW }, NOW)).toMatchObject({ ok: false, reason: 'acr_insufficient' })
    expect(checkStepUp({ auth_time: NOW }, NOW)).toMatchObject({ ok: false, reason: 'acr_insufficient' })
    expect(checkStepUp({ acr: 'loa2' }, NOW)).toMatchObject({ ok: false, reason: 'auth_time_missing' })
    expect(checkStepUp({ acr: 'loa2', auth_time: '1800000000' }, NOW)).toMatchObject({ ok: false, reason: 'auth_time_missing' })
    expect(checkStepUp({ acr: 'loa2', auth_time: NOW - 301 }, NOW)).toMatchObject({ ok: false, reason: 'auth_time_stale' })
    expect(checkStepUp({ acr: 'loa2', auth_time: NOW + 3600 }, NOW)).toMatchObject({ ok: false, reason: 'auth_time_stale' })
  })
  it('max_age 0 style: a tighter window is honoured', () => {
    expect(checkStepUp({ acr: 'loa2', auth_time: NOW - 5 }, NOW, 0)).toMatchObject({ ok: false })
  })
})

describe('catalogue invariants', () => {
  it('finance never carries newsletter.send; helper is member minus vote, quorum, office, portfolio', () => {
    expect(roleDef('finance')!.capabilities).not.toContain('newsletter.send')
    const member = new Set(roleDef('member')!.capabilities)
    const helper = new Set(roleDef('helper')!.capabilities)
    for (const k of ['gov.vote.cast', 'gov.quorum.count', 'gov.office.hold', 'gov.portfolio.hold']) {
      expect(member.has(k)).toBe(true)
      expect(helper.has(k)).toBe(false)
    }
    for (const k of ['gov.agenda_item.propose', 'brd.card.own']) expect(helper.has(k)).toBe(true)
  })
  it('every capability key matches the SCHEMA key shape; kernel keys are idt.* and only those', () => {
    const shape = /^[a-z][a-z_]{1,39}\.[a-z][a-z_.]{0,79}$/
    for (const c of CAPABILITIES) {
      expect(shape.test(c.key)).toBe(true)
      expect(c.moduleKey === null).toBe(c.key.startsWith('idt.'))
    }
    for (const r of ROLES) expect(/^[a-z][a-z0-9_]{1,39}$/.test(r.key)).toBe(true)
  })
})
