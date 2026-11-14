import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import ResolutionRow from './ResolutionRow.svelte'

// Governance Core INV-5 (display contract): the result is COMPUTED from
// the pre-declared rule + tallies server-side — it is never an admin's free hand.
// The row therefore renders the result read-only (tagged 'berechnet') and never
// offers a result <select>. The decision rule is FIXED at creation: a brand-new
// resolution (no id) may still pick `required_majority`, but once it has an id
// the rule is locked and shown as a read-only chip ('Bei Erstellung festgelegt').

const baseResolution = {
  id: 'res-1',
  sequence_nr: 1,
  global_nr: null,
  text: 'Antrag auf X',
  votes_yes: 2,
  votes_no: 1,
  votes_abstain: 0,
  result: 'passed' as const,
  required_majority: 'simple' as const,
}

const noopSave = () => {}
const noopDelete = () => {}

async function enterEditMode(getByText: (t: string) => HTMLElement) {
  // The editor (where a result <select> would have lived) is only mounted after
  // the admin clicks "Bearbeiten" — drive into that state before asserting.
  await fireEvent.click(getByText('Bearbeiten'))
}

describe('ResolutionRow — INV-5 display contract', () => {
  test('renders NO editable result <select> in edit mode — result is read-only ("berechnet")', async () => {
    const { container, getByText } = render(ResolutionRow, {
      props: {
        resolution: { ...baseResolution },
        isAdmin: true,
        protocolId: 'p-1',
        onSave: noopSave,
        onDelete: noopDelete,
      },
    })
    await enterEditMode(getByText)

    // No free-hand result dropdown may exist anywhere in the rendered row.
    const selects = Array.from(container.querySelectorAll('select'))
    const resultSelect = selects.find((s) =>
      Array.from(s.options).some((o) => ['passed', 'rejected', 'withdrawn'].includes(o.value)),
    )
    expect(resultSelect).toBeUndefined()

    // The computed result is surfaced read-only, tagged 'berechnet' (the tag sits
    // inside "(berechnet)" so match the substring, not the whole text node).
    expect(getByText(/berechnet/)).toBeTruthy()
  })

  test('for a resolution WITH an id, renders NO required_majority selector — a locked chip ("Bei Erstellung festgelegt") instead', async () => {
    const { container, getByText, queryByText } = render(ResolutionRow, {
      props: {
        resolution: { ...baseResolution },
        isAdmin: true,
        protocolId: 'p-1',
        onSave: noopSave,
        onDelete: noopDelete,
      },
    })
    await enterEditMode(getByText)

    // The decision rule is fixed at creation: an existing row exposes NO selector
    // whose options are the majority rules.
    const selects = Array.from(container.querySelectorAll('select'))
    const ruleSelect = selects.find((s) =>
      Array.from(s.options).some((o) => ['simple', 'two_thirds', 'absolute'].includes(o.value)),
    )
    expect(ruleSelect).toBeUndefined()

    // …and the lock is shown to the admin as a read-only chip (the phrase sits in
    // a longer chip label, so match the substring).
    expect(queryByText(/Bei Erstellung festgelegt/)).toBeTruthy()
  })
})

// R28 house review MEDIUM (svelte lens, x2): rows that the API creates in the
// Phase-2 shapes rendered wrongly. A support_threshold row never passed its
// stored fraction to computeResult, so a complete tally previewed as
// "nicht berechenbar (Stimmen unvollständig)"; an acclamation row (NULL
// tallies) rendered " Ja /  Nein /  Enthal." plus an inert rule label.
describe('ResolutionRow — Phase-2 row shapes from the API', () => {
  function renderRow(resolution: Record<string, unknown>, eligibleVotingCount = 0) {
    return render(ResolutionRow, {
      props: {
        resolution: { ...baseResolution, ...resolution } as never,
        isAdmin: true,
        protocolId: 'p-1',
        eligibleVotingCount,
        onSave: noopSave,
        onDelete: noopDelete,
      },
    })
  }

  test('support_threshold preview uses the STORED fraction: a complete tally is computed, not "unvollständig"', async () => {
    // eligible 4, fraction 0.5 -> threshold 2; yes 2 passes.
    const { getByText, queryByText } = renderRow(
      { required_majority: 'support_threshold', decision_rule_params: { fraction: 0.5 }, votes_yes: 2, votes_no: 1 },
      4,
    )
    await enterEditMode(getByText)
    expect(queryByText(/nicht berechenbar/)).toBeNull()
    expect(getByText(/Angenommen/)).toBeTruthy()
    expect(getByText(/berechnet/)).toBeTruthy()
  })

  test('support_threshold row with no stored fraction names the missing rule parameter, not the votes', async () => {
    const { getByText, queryByText } = renderRow({ required_majority: 'support_threshold', votes_yes: 2, votes_no: 1 }, 4)
    await enterEditMode(getByText)
    expect(queryByText(/Stimmen unvollständig/)).toBeNull()
    expect(getByText(/Regel unvollständig/)).toBeTruthy()
  })

  test('acclamation row, read view: "per Akklamation" instead of an empty tally and the inert rule label', () => {
    const { container, getByText } = renderRow({
      adoption_mode: 'acclamation', votes_yes: null, votes_no: null, votes_abstain: null,
    })
    expect(getByText(/per Akklamation/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/Ja \//)
    expect(container.textContent).not.toMatch(/Einfache Mehrheit/)
  })

  test('acclamation row, edit preview: the declared result, never "Stimmen unvollständig"', async () => {
    const { getByText, queryByText } = renderRow({
      adoption_mode: 'acclamation', result: 'passed', votes_yes: null, votes_no: null, votes_abstain: null,
    })
    await enterEditMode(getByText)
    expect(queryByText(/Stimmen unvollständig/)).toBeNull()
    expect(getByText(/per Akklamation festgestellt/)).toBeTruthy()
  })
})

// Finding 7 (E2E 2026-11-11): a freshly added decision (text empty, tally 0/0/0)
// rendered "Abgelehnt · 0/0/0" before any vote existed, and the three tally
// fields were announced only by their placeholders.
describe('ResolutionRow — a decision without a vote (finding 7)', () => {
  const fresh = { ...baseResolution, text: '', votes_yes: 0, votes_no: 0, votes_abstain: 0, result: 'rejected' as const }

  function renderFresh(over: Record<string, unknown> = {}, isAdmin = true) {
    return render(ResolutionRow, {
      props: {
        resolution: { ...fresh, ...over } as never,
        isAdmin,
        protocolId: 'p-1',
        onSave: noopSave,
        onDelete: noopDelete,
      },
    })
  }

  test('read view shows "noch keine Abstimmung" and no Angenommen/Abgelehnt', () => {
    const { container, getByText } = renderFresh()
    expect(getByText(/noch keine Abstimmung/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/Angenommen|Abgelehnt/)
    expect(container.textContent).not.toMatch(/0 Ja \/ 0 Nein/)
  })

  // Consent is the one rule where silence adopts: with no objection recorded the
  // server stores "passed" for an empty tally and adopts it at publish, so the
  // row must show that decision and not a missing vote.
  test('a consent row with an empty tally is adopted, not a missing vote', () => {
    const { container } = renderFresh({ required_majority: 'consent', result: 'passed' })
    expect(container.textContent).toMatch(/Angenommen/)
    expect(container.textContent).toMatch(/Konsens/)
    expect(container.textContent).not.toMatch(/noch keine Abstimmung/)
  })

  test('the edit preview of a consent row with an empty tally shows the computed "Angenommen"', async () => {
    const { container, getByText } = renderFresh({ required_majority: 'consent', result: 'passed' })
    await enterEditMode(getByText)
    expect(container.textContent).toMatch(/Angenommen/)
    expect(container.textContent).toMatch(/berechnet/)
    expect(container.textContent).not.toMatch(/noch keine Abstimmung/)
  })

  test('edit preview shows "noch keine Abstimmung" instead of a computed verdict', async () => {
    const { container, getByText } = renderFresh()
    await enterEditMode(getByText)
    expect(container.textContent).toMatch(/noch keine Abstimmung/)
    expect(container.textContent).not.toMatch(/Angenommen|Abgelehnt/)
  })

  test('once counts are saved the verdict is shown again', () => {
    const { container } = renderFresh({ votes_yes: 3, votes_no: 1, result: 'passed' })
    expect(container.textContent).toMatch(/Angenommen/)
    expect(container.textContent).not.toMatch(/noch keine Abstimmung/)
  })

  test('a withdrawn row keeps its verdict even with an empty tally', () => {
    const { container } = renderFresh({ result: 'withdrawn' })
    expect(container.textContent).toMatch(/Zurückgezogen/)
    expect(container.textContent).not.toMatch(/noch keine Abstimmung/)
  })

  test('an acclamation row is not a missing vote', () => {
    const { container } = renderFresh({
      adoption_mode: 'acclamation', result: 'passed', votes_yes: null, votes_no: null, votes_abstain: null,
    })
    expect(container.textContent).toMatch(/Angenommen/)
    expect(container.textContent).not.toMatch(/noch keine Abstimmung/)
  })

  test('the Ja, Nein and Enthaltung fields have visible labels bound to the inputs', async () => {
    const { getByText, getByLabelText } = renderFresh()
    await enterEditMode(getByText)
    for (const label of ['Ja', 'Nein', 'Enthaltung']) {
      expect(getByText(label, { selector: 'label' })).toBeTruthy()
      expect(getByLabelText(label).tagName).toBe('INPUT')
    }
  })

  test('clearing every tally field in the editor reports missing counts, not "noch keine Abstimmung"', async () => {
    const { container, getByText, getByLabelText } = renderFresh()
    await enterEditMode(getByText)
    for (const label of ['Ja', 'Nein', 'Enthaltung']) {
      await fireEvent.input(getByLabelText(label), { target: { value: '' } })
    }
    expect(container.textContent).toMatch(/Stimmen unvollständig/)
    expect(container.textContent).not.toMatch(/noch keine Abstimmung/)
  })
})

// IT-admin pass 2026-11-13: "+ Beschluss hinzufügen" stored an empty decision at
// once. The row now serves as the entry form for an UNSAVED draft (no id): it
// opens in edit mode, refuses to save without text, and Abbrechen discards it.
describe('ResolutionRow — unsaved draft (entry form)', () => {
  const blank = {
    sequence_nr: 1, global_nr: null, text: '', votes_yes: 0, votes_no: 0, votes_abstain: 0,
    result: 'rejected' as const, required_majority: 'simple' as const,
  }

  function renderDraft(onSave: (r: never) => unknown = vi.fn()) {
    const onCancel = vi.fn()
    const utils = render(ResolutionRow, {
      props: {
        resolution: { ...blank } as never,
        isAdmin: true,
        protocolId: 'p-1',
        startEditing: true,
        onSave,
        onDelete: vi.fn(),
        onCancel,
      } as never,
    })
    return { ...utils, onSave, onCancel }
  }

  test('opens directly as the entry form, with the rule picker a new decision may still use', () => {
    const { getByPlaceholderText, getByLabelText } = renderDraft()
    expect(getByPlaceholderText('Beschlusstext')).toBeTruthy()
    expect(getByLabelText('Erforderliche Mehrheit')).toBeTruthy()
  })

  test('Speichern without text does not save and says why', async () => {
    const { getByText, getByRole, onSave } = renderDraft()
    await fireEvent.click(getByText('Speichern'))
    expect(onSave).not.toHaveBeenCalled()
    expect(getByRole('alert').textContent).toMatch(/Beschlusstext/)
  })

  test('Speichern with whitespace-only text does not save', async () => {
    const { getByText, getByPlaceholderText, onSave } = renderDraft()
    await fireEvent.input(getByPlaceholderText('Beschlusstext'), { target: { value: '   ' } })
    await fireEvent.click(getByText('Speichern'))
    expect(onSave).not.toHaveBeenCalled()
  })

  test('Speichern with text hands the draft to onSave', async () => {
    const { getByText, getByPlaceholderText, onSave } = renderDraft()
    await fireEvent.input(getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.click(getByText('Speichern'))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toBe('Antrag A')
  })

  test('a failed save keeps the form open so the typed text is not lost', async () => {
    const { getByText, getByPlaceholderText } = renderDraft(vi.fn().mockResolvedValue(false))
    await fireEvent.input(getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.click(getByText('Speichern'))
    await new Promise((r) => setTimeout(r, 0))
    expect((getByPlaceholderText('Beschlusstext') as HTMLInputElement).value).toBe('Antrag A')
  })

  test('Speichern is ignored while the first save is still pending', async () => {
    let settle!: (ok: boolean) => void
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve }))
    const { getByText, getByPlaceholderText } = renderDraft(onSave)
    await fireEvent.input(getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.click(getByText('Speichern'))
    await fireEvent.click(getByText('Speichern'))
    await fireEvent.click(getByText('Abbrechen'))
    expect(onSave).toHaveBeenCalledTimes(1)
    settle(false)
    await new Promise((r) => setTimeout(r, 0))
    // A refused save re-enables the form.
    await fireEvent.click(getByText('Speichern'))
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  test('a draft with a cleared count is not saved', async () => {
    const { getByText, getByPlaceholderText, getByLabelText, getByRole, onSave } = renderDraft()
    await fireEvent.input(getByPlaceholderText('Beschlusstext'), { target: { value: 'Antrag A' } })
    await fireEvent.input(getByLabelText('Nein'), { target: { value: '' } })
    await fireEvent.click(getByText('Speichern'))
    expect(onSave).not.toHaveBeenCalled()
    expect(getByRole('alert').textContent).toMatch(/Stimmzahlen/)
  })

  test('Abbrechen on a draft calls onCancel and saves nothing', async () => {
    const { getByText, onSave, onCancel } = renderDraft()
    await fireEvent.click(getByText('Abbrechen'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  test('an existing row with its text cleared cannot be saved either', async () => {
    const onSave = vi.fn()
    const { getByText, getByPlaceholderText } = render(ResolutionRow, {
      props: { resolution: { ...baseResolution } as never, isAdmin: true, protocolId: 'p-1', onSave, onDelete: noopDelete },
    })
    await enterEditMode(getByText)
    await fireEvent.input(getByPlaceholderText('Beschlusstext'), { target: { value: '' } })
    await fireEvent.click(getByText('Speichern'))
    expect(onSave).not.toHaveBeenCalled()
  })
})
