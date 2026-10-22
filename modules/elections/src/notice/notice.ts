// The enable-time notice of the optional elections module (PRD-ELE-002,
// TRD-030). Shown to the administrator at the moment the module is enabled.
//
// Honest scope: the module does not run the university's statutory election,
// it is optional and the council administration can switch it off (no default claim:
// the running system still serves it on by default until TASK-044-b). The wording is the one fixed in
// docs/compliance/elections-scope.md section 1; that page's section 2 lists the
// phrasings no material may use, and notice.test.ts pins this text against them.
//
// Du/Sie: the interface addresses people with "Du" by default and a council can
// switch its whole instance to "Sie" (UX-013), so every string with a pronoun is
// authored as a pair here, not patched per screen.

export const ELECTIONS_MODULE_ID = 'elections'
export const ELECTIONS_NOTICE_ID = 'elections.enable-notice'

export type Address = 'du' | 'sie'

/**
 * The facts the prose states. A caller that lays the notice out itself reads
 * these, not the prose; the test pins both to each other.
 */
export interface ElectionsNoticeFacts {
  readonly optional: true
  readonly defaultEnabled: false
  readonly runsStatutoryElection: false
}

export interface ElectionsEnableNotice {
  readonly id: typeof ELECTIONS_NOTICE_ID
  readonly moduleId: typeof ELECTIONS_MODULE_ID
  readonly locale: 'de'
  readonly address: Address
  readonly facts: ElectionsNoticeFacts
  readonly title: string
  /** Shown in order, one paragraph each. */
  readonly paragraphs: readonly string[]
  /** The label of the one confirmation the enable step asks for. */
  readonly acknowledgeLabel: string
}

export const ELECTIONS_NOTICE_FACTS: ElectionsNoticeFacts = Object.freeze({
  optional: true,
  defaultEnabled: false,
  runsStatutoryElection: false,
})

/** The scope statement itself; identical for both forms of address. */
export const ELECTIONS_SCOPE_STATEMENT =
  'Dieses Modul führt keine satzungsgemäßen Wahlen der Hochschule durch. Es ist optional und kann von der Verwaltung des Gremiums ausgeschaltet werden.'

const FOLLOW_UP: Readonly<Record<Address, string>> = Object.freeze({
  du: 'Schalte es nur ein, wenn dein Gremium intern abstimmen oder wählen will. Die Wahl der Hochschule richtet weiterhin die Hochschule aus.',
  sie: 'Schalten Sie es nur ein, wenn Ihr Gremium intern abstimmen oder wählen möchte. Die Wahl der Hochschule richtet weiterhin die Hochschule aus.',
})

export function electionsEnableNotice(address: Address = 'du'): ElectionsEnableNotice {
  if (address !== 'du' && address !== 'sie') {
    throw new RangeError(`unknown form of address ${JSON.stringify(address)} (expected "du" or "sie")`)
  }
  return {
    id: ELECTIONS_NOTICE_ID,
    moduleId: ELECTIONS_MODULE_ID,
    locale: 'de',
    address,
    facts: ELECTIONS_NOTICE_FACTS,
    title: 'Hinweis zum Wahlmodul',
    paragraphs: [ELECTIONS_SCOPE_STATEMENT, FOLLOW_UP[address]],
    acknowledgeLabel: 'Verstanden',
  }
}
