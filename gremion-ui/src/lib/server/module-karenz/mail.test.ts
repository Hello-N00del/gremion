// @vitest-environment node
//
// Module Karenz (phase 2, Task 9): the info mail and its two reminders. The renderer is a pure
// function; what these tests pin is what the mail says and what it can never say.
import { describe, expect, it } from 'vitest'
import { renderKarenzMail, reminderDue, type KarenzMailInput } from './mail'

const DAY = 24 * 3_600_000
const SWITCHED_OFF = new Date('2026-11-01T10:30:00Z')
const FINAL_AT = new Date(SWITCHED_OFF.getTime() + 30 * DAY) // 2026-12-01

const base = (over: Partial<KarenzMailInput> = {}): KarenzMailInput => ({
  moduleLabel: 'Abstimmungen',
  switchedOffAt: SWITCHED_OFF,
  finalAt: FINAL_AT,
  kind: 'switchoff',
  settingsUrl: 'https://rat.example.test/settings/module',
  ...over,
})

describe('renderKarenzMail', () => {
  it("never contains the actor's id, e-mail or display name: the renderer has no actor parameter", () => {
    const actor = { id: 'b7c1d2e3-actor-0000-aaaa-123456789abc', email: 'wer.auch.immer@actor.example.test', name: 'Zora Zufallsname' }
    for (const kind of ['switchoff', 't23', 't29'] as const) {
      // @ts-expect-error KarenzMailInput has no field that could carry a person
      const out = renderKarenzMail({ ...base({ kind }), actorUserId: actor.id, actorEmail: actor.email, actorName: actor.name })
      const text = `${out.subject}\n${out.html}`
      for (const secret of [actor.id, actor.email, actor.name, 'Zufallsname']) expect(text).not.toContain(secret)
    }
    // and the mail does not hint at a person either
    const out = renderKarenzMail(base())
    expect(out.html).not.toMatch(/ausgeschaltet von|switched off by|durch\s+\S+\s+ausgeschaltet/i)
  })

  it('names the module and the final deletion date for all three kinds, German first and English below', () => {
    for (const kind of ['switchoff', 't23', 't29'] as const) {
      const out = renderKarenzMail(base({ kind }))
      const text = `${out.subject}\n${out.html}`
      expect(text, kind).toContain('Abstimmungen')
      expect(text, kind).toContain('1. Dezember 2026')
      expect(text, kind).toContain('1 December 2026')
      expect(out.html.indexOf('Dezember'), kind).toBeLessThan(out.html.indexOf('December'))
      // when it was switched off
      expect(out.html, kind).toContain('1. November 2026')
      expect(out.html, kind).toContain('1 November 2026')
      // that switching it on again restores everything, and the link
      expect(out.html, kind).toMatch(/wieder ein/i)
      expect(out.html, kind).toMatch(/switch(ing)? it (back )?on again/i)
      expect(out.html, kind).toContain('href="https://rat.example.test/settings/module"')
    }
  })

  it('the reminders say they are reminders; the first mail does not', () => {
    expect(renderKarenzMail(base({ kind: 'switchoff' })).subject).not.toMatch(/Erinnerung|Reminder/)
    expect(renderKarenzMail(base({ kind: 't23' })).subject).toMatch(/Erinnerung/)
    expect(renderKarenzMail(base({ kind: 't29' })).subject).toMatch(/reminder/i)
    expect(renderKarenzMail(base({ kind: 't23' })).subject).not.toBe(renderKarenzMail(base({ kind: 't29' })).subject)
  })

  it('the day-29 subject carries the date and no relative day: a catch-up can send it on the day itself', () => {
    const subject = renderKarenzMail(base({ kind: 't29' })).subject
    expect(subject).toContain('1. Dezember 2026')
    expect(subject).toContain('1 December 2026')
    expect(subject).not.toMatch(/morgen|tomorrow/i)
  })

  it('escapes the label and the link: nothing from the input becomes markup', () => {
    const out = renderKarenzMail(base({ moduleLabel: '<script>alert(1)</script>', settingsUrl: 'https://x.test/a"onmouseover="b' }))
    expect(out.html).not.toContain('<script>')
    expect(out.html).toContain('&lt;script&gt;')
    expect(out.html).not.toContain('"onmouseover="')
  })

  it('formats dates in Europe/Berlin, not UTC: 23:30 UTC on Nov 30 is Dec 1 in Berlin', () => {
    const out = renderKarenzMail(base({ finalAt: new Date('2026-11-30T23:30:00Z') }))
    expect(out.html).toContain('1. Dezember 2026')
  })
})

describe('reminderDue', () => {
  it('t23 is finalAt minus 7 days and t29 is finalAt minus 1 day, to the second', () => {
    expect(reminderDue('t23', FINAL_AT).getTime()).toBe(FINAL_AT.getTime() - 7 * DAY)
    expect(reminderDue('t29', FINAL_AT).getTime()).toBe(FINAL_AT.getTime() - 1 * DAY)
    // switch-off at 10:30:00 -> day 23 and day 29 at 10:30:00
    expect(reminderDue('t23', FINAL_AT).toISOString()).toBe('2026-11-24T10:30:00.000Z')
    expect(reminderDue('t29', FINAL_AT).toISOString()).toBe('2026-11-30T10:30:00.000Z')
  })
})
