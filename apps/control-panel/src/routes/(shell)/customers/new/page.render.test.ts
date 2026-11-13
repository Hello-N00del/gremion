// "Neuer Mandant" form: pins the two semester selects. If one is renamed or
// dropped, the action reads no months, validation treats that as an older
// caller and every new customer silently shows the static dash; this test
// makes that loud.
import { describe, expect, it } from 'vitest'
import { render } from 'svelte/server'
import Page from './+page.svelte'

const DATA = { key: '0192f0c4-0000-7000-8000-00000000000a', modules: [], expectedHost: null, disabled: null }

function html(form?: unknown): string {
  return render(Page, { props: { data: DATA, form } as never }).body
}

/** The `<select name=...>` element with its options, as raw markup. */
function selectOf(markup: string, name: string): string {
  const m = markup.match(new RegExp(`<select name="${name}"[^>]*>[\\s\\S]*?</select>`))
  if (!m) throw new Error(`no <select name="${name}"> in the form`)
  return m[0]
}

/** value and label of the selected option. */
function selectedOf(select: string): { value: string; label: string } {
  const m = select.match(/<option value="(\d+)"[^>]*\bselected\b[^>]*>([^<]*)<\/option>/)
  if (!m) throw new Error('no option is selected')
  return { value: m[1]!, label: m[2]! }
}

describe('Neuer Mandant semester selects', () => {
  it('offers both selects with October and April preselected on a fresh form', () => {
    const markup = html()
    const winter = selectOf(markup, 'termWinterMonth')
    const summer = selectOf(markup, 'termSummerMonth')
    expect(winter.match(/<option /g)).toHaveLength(12)
    expect(summer.match(/<option /g)).toHaveLength(12)
    expect(selectedOf(winter)).toEqual({ value: '10', label: 'Oktober' })
    expect(selectedOf(summer)).toEqual({ value: '4', label: 'April' })
    expect(markup).toContain('Wintersemester beginnt im')
    expect(markup).toContain('Sommersemester beginnt im')
  })

  it('keeps the chosen months and shows the term error after a failed submit', () => {
    const markup = html({
      values: { termWinterMonth: 4, termSummerMonth: 4 },
      errors: { termMonths: 'Die beiden Monate müssen verschieden sein.' },
    })
    const winter = selectOf(markup, 'termWinterMonth')
    const summer = selectOf(markup, 'termSummerMonth')
    expect(selectedOf(winter)).toEqual({ value: '4', label: 'April' })
    expect(selectedOf(summer)).toEqual({ value: '4', label: 'April' })
    for (const s of [winter, summer]) {
      expect(s).toContain('aria-invalid="true"')
      expect(s).toContain('aria-describedby="err-term"')
    }
    expect(markup).toContain('id="err-term"')
    expect(markup).toContain('Die beiden Monate müssen verschieden sein.')
  })
})
