// "Neuer Mandant" form: pins the two semester selects. If one is renamed or
// dropped, the action reads no months, validation treats that as an older
// caller and every new customer silently shows the static dash; this test
// makes that loud.
import { describe, expect, it } from 'vitest'
import { render } from 'svelte/server'
import Page from './+page.svelte'

const DATA = { key: '0192f0c4-0000-7000-8000-00000000000a', modules: [], expectedHost: null, disabled: null }

function html(form?: unknown, data: Record<string, unknown> = DATA): string {
  return render(Page, { props: { data, form } as never }).body
}

/** The text of the host field's hints, markup and comments stripped. */
function hostHints(data: Record<string, unknown>): string {
  const label = html(undefined, data).match(/<label[^>]*>(?:(?!<\/label>)[\s\S])*?name="host"[\s\S]*?<\/label>/)
  if (!label) throw new Error('no Host field in the form')
  return label[0].replace(/<input[^>]*>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
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

describe('Neuer Mandant host field: the secondary customer hosts', () => {
  const PRIMARY = { ...DATA, expectedHost: 'rat.proof.example' }

  it('without secondary hosts the sentence is the one it always was, and no secondary note is shown', () => {
    for (const data of [PRIMARY, { ...PRIMARY, secondaryHosts: [] }]) {
      const text = hostHints(data)
      expect(text).toContain('Diese Installation ist für den Host rat.proof.example eingerichtet; jeder andere Host wird beim Anlegen abgelehnt.')
      expect(text).not.toContain('Zusätzlich erlaubt')
      expect(text).not.toContain('Videokonferenz')
    }
  })

  it('with secondary hosts it names them and says plainly what a customer on such a host does not have', () => {
    const text = hostHints({ ...PRIMARY, secondaryHosts: ['canary.example.org', 'test.example.net'] })
    expect(text).toContain('Diese Installation ist für den Host rat.proof.example eingerichtet.')
    expect(text).toContain('Zusätzlich erlaubt: canary.example.org, test.example.net')
    expect(text).toContain('jeder andere Host wird beim Anlegen abgelehnt')
    expect(text).toContain('hat keinen Chat, keine Dateien, keine Dokumentbearbeitung und keine Videokonferenz')
    expect(text).toContain('Abstimmungen, Inhalte und Newsletter')
  })

  it('the note is described by the field (aria-describedby names every hint) and the host stays preset to the customer host', () => {
    const markup = html(undefined, { ...PRIMARY, secondaryHosts: ['canary.example.org'] })
    expect(markup).toMatch(/name="host"[^>]*aria-describedby="host-expected host-secondary"/)
    expect(markup).toContain('id="host-secondary"')
    expect(markup).toMatch(/name="host"[^>]*value="rat\.proof\.example"/)
  })

  it('no customer host known: no hint at all, the secondary hosts are not shown on their own', () => {
    const text = hostHints({ ...DATA, expectedHost: null, secondaryHosts: ['canary.example.org'] })
    expect(text).toBe('Host')
  })
})

describe('Neuer Mandant host field: the opted-in modules of a secondary host', () => {
  const PRIMARY = { ...DATA, expectedHost: 'rat.proof.example', secondaryHosts: ['canary.example.org'] }
  const NOTE_START = 'Ein Mandant auf einem dieser zusätzlichen Hosts hat'

  it('no opt-in (key absent, empty, or an older page data): the note is the one it always was', () => {
    const base = hostHints(PRIMARY)
    expect(base).toContain('Ein Mandant auf einem dieser zusätzlichen Hosts hat keinen Chat, keine Dateien, keine Dokumentbearbeitung und keine Videokonferenz; auch Abstimmungen, Inhalte und Newsletter sind dort nicht verfügbar.')
    expect(hostHints({ ...PRIMARY, secondaryModules: [] })).toBe(base)
    expect(base).not.toContain('freigegeben')
  })

  it('files and votes opted in: the note lists what the customer has and what it still lacks, and says existing customers keep their locks', () => {
    const text = hostHints({ ...PRIMARY, secondaryModules: ['files', 'votes'] })
    expect(text).toContain(`${NOTE_START} Anmeldung, Board und Kalender sowie, für diese Installation freigegeben: Dateien, Dokumentbearbeitung und Abstimmungen.`)
    expect(text).toContain('Nicht verfügbar sind dort: Chat, Videokonferenz, Inhalte und Newsletter.')
    expect(text).toContain('Bereits angelegte Mandanten auf diesen Hosts behalten ihre bisherigen Sperren')
    expect(text).not.toContain('keine Dateien')
    expect(text).not.toContain('keinen Chat')
    expect(text).toContain('Zusätzlich erlaubt: canary.example.org')
  })

  it('only votes opted in: files and office editing stay on the lacking side', () => {
    const text = hostHints({ ...PRIMARY, secondaryModules: ['votes'] })
    expect(text).toContain('freigegeben: Abstimmungen.')
    expect(text).toContain('Nicht verfügbar sind dort: Chat, Dateien, Dokumentbearbeitung, Videokonferenz, Inhalte und Newsletter.')
  })

  it('messaging opted in: chat moves to the available side, video never does', () => {
    const text = hostHints({ ...PRIMARY, secondaryModules: ['messaging'] })
    expect(text).toContain('freigegeben: Chat.')
    expect(text).toContain('Nicht verfügbar sind dort: Dateien, Dokumentbearbeitung, Videokonferenz, Abstimmungen, Inhalte und Newsletter.')
  })

  it('every opt-in of the set: only video, content and newsletter remain unavailable', () => {
    const text = hostHints({ ...PRIMARY, secondaryModules: ['files', 'votes', 'messaging'] })
    expect(text).toContain('Nicht verfügbar sind dort: Videokonferenz, Inhalte und Newsletter.')
  })

  it('the opt-in is shown only next to secondary hosts and a known customer host', () => {
    expect(hostHints({ ...PRIMARY, secondaryHosts: [], secondaryModules: ['files'] })).not.toContain('freigegeben')
    expect(hostHints({ ...PRIMARY, expectedHost: null, secondaryModules: ['files'] })).toBe('Host')
  })
})
