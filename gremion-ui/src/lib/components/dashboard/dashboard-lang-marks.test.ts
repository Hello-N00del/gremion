import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { catalogueText, fragmentsOf, unchangedUnderLang, unmarkedCatalogueText } from '$lib/i18n/lang-marks.testkit'
import FeaturedMeeting from './FeaturedMeeting.svelte'
import PageHead from './PageHead.svelte'
import type { Upcoming } from './types'

// locale-en unit, WCAG 3.1.2: the dashboard is declared German, but its greeting, countdown and the word
// "Heute" in the meeting pill come from the catalogue in the person's language. The weekday and date of a
// later meeting are German literals and must not be called English.
const meeting = (startIso: string): Upcoming => ({ id: 'm1', startIso, title: 'Sitzung', where: 'Raum 1', mine: true, hue: 0 })
const today = () => new Date().toISOString()
const inThreeDays = () => new Date(Date.now() + 3 * 86_400_000).toISOString()

const pageHeadProps = (nextMeeting: Upcoming | null) => ({
  nextMeeting,
  firstName: 'Ada',
  isMember: true,
  financeEnabled: false,
  approvalsCount: 0,
  liveVotesCount: 0,
  myEventCount: 0,
  gremienPlural: 'Gremien',
  newExpenseHref: null
})

function html(locale: 'de' | 'en', which: 'featured' | 'head', startIso: string): string {
  document.documentElement.lang = locale
  const { container } =
    which === 'featured'
      ? render(FeaturedMeeting, { props: { nextMeeting: meeting(startIso) } })
      : render(PageHead, { props: pageHeadProps(meeting(startIso)) })
  const out = container.innerHTML
  cleanup()
  return out
}

afterEach(() => {
  document.documentElement.lang = ''
})

describe('dashboard language marks', () => {
  for (const which of ['featured', 'head'] as const) {
    for (const [name, startIso] of [['today', today()], ['a later day', inThreeDays()]] as const) {
      it(`en, ${which}, meeting ${name}: every catalogue fragment sits under lang="en"`, () => {
        const de = html('de', which, startIso)
        const en = html('en', which, startIso)
        expect(catalogueText(de, en).length, 'the guard sees catalogue text').toBeGreaterThanOrEqual(1)
        expect(unmarkedCatalogueText(de, en, 'en').map((f) => `${f.where} ${JSON.stringify(f.text)}`)).toEqual([])
      })
    }
  }

  it('en: the German weekday and date of a later meeting are marked German, not English', () => {
    const en = fragmentsOf(html('en', 'featured', inThreeDays()))
    const pill = en.find((f) => f.text.includes(' · ') && /\d{2}:\d{2}/.test(f.text) && f.where === '<span>')
    expect(pill, 'the pill is rendered').toBeDefined()
    expect(pill!.lang).toBe('de')
  })

  it('en: "Heute" of a meeting today is marked English', () => {
    const en = fragmentsOf(html('en', 'featured', today()))
    expect(en.find((f) => /\d{2}:\d{2}/.test(f.text) && f.where === '<span>')?.lang).toBe('en')
  })

  it('en: nothing under lang="en" is a German literal (the meeting title and place stay unmarked)', () => {
    for (const which of ['featured', 'head'] as const) {
      const suspects = unchangedUnderLang(html('de', which, today()), html('en', which, today()), 'en').filter((f) => /\p{L}{2,}/u.test(f.text))
      // The first name is a name, spelt the same in both languages.
      expect(suspects.map((f) => f.text).filter((t) => !t.includes('Ada'))).toEqual([])
    }
  })
})
