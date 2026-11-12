// A counted resolution that nobody voted on (see
// $lib/governance/resolution-vote-state) is not a decision and must never be
// adopted. Kept apart from protocol-db so the routes can name the refusal
// without importing the persistence module.

/** The refusal when the row cannot be placed in the protocol's list (the adoption record). */
export const UNTALLIED_RESOLUTION_MESSAGE =
  'Ein Beschluss hat noch keine Abstimmung. Bitte die Stimmen eintragen oder den Beschluss zurückziehen oder löschen.'

/**
 * Thrown by recordResolutionAdoptions when the row it is about to record as a
 * decision carries no vote. It runs on the publish transaction, so the throw
 * rolls the whole publish back; the route answers 422.
 */
export class UntalliedResolutionError extends Error {
  constructor(public readonly resolutionId: string) {
    super(`Beschluss ${resolutionId} hat noch keine Abstimmung und kann nicht als Entscheidung festgehalten werden`)
    this.name = 'UntalliedResolutionError'
  }
}
