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

describe('Neuer Mandant board hint', () => {
  const hint = (): string => {
    const m = html().match(/<p id="board-hint"[^>]*>([\s\S]*?)<\/p>/)
    if (!m) throw new Error('no board hint in the form')
    return m[1]!.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
  }

  it('tells the operator an unticked board is still on and how to hide it', () => {
    const markup = html()
    expect(markup).toContain('id="board-hint"')
    expect(markup).toContain('Modul aktivieren')
    expect(markup).toContain('Modul deaktivieren')
    expect(hint()).toContain('nicht angekreuztes')
  })

  it('says that a ticked board has its own database and can be restored for 30 days after it is switched off', () => {
    const text = hint()
    expect(text).toContain('eigene Datenbank')
    expect(text).toContain('30 Tage')
    expect(text).toContain('wiederherstellbar')
  })

  it('no longer says the board runs in-process on the kernel tables', () => {
    const text = hint().toLowerCase()
    for (const old of ['in-process', 'im prozess', 'kerntabellen', 'kernel tables', 'in-prozess']) expect(text).not.toContain(old)
  })

  it('is written in German and carries no emoji or pictograph', () => {
    const text = hint()
    expect(text).toMatch(/Board|board/)
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(text).not.toMatch(/(the|database|restore)/i)
  })

  it('board stays selectable: its checkbox is not disabled, next to the note', () => {
    const markup = render(Page, { props: { data: { ...DATA, modules: [{ id: 'board', name: 'Board', denied: null }] }, form: undefined } as never }).body
    const box = markup.match(/<input type="checkbox" name="enable" value="board"[^>]*>/)?.[0]
    expect(box).toBeDefined()
    expect(box).not.toContain('disabled')
    expect(markup).toContain('id="board-hint"')
  })
})

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
