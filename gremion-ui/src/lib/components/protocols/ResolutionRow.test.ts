import { describe, test, expect } from 'vitest'
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
