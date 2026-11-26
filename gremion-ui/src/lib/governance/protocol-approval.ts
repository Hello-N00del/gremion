// Publishing minutes needs a second person.
//
// A submitted protocol is published by someone who
//   (a) is not the person who submitted it,
//   (b) is not the person who created it (the only author the model records), and
//   (c) may approve for the body: a customer admin or a voting member of it.
//
// One pure function, used by the publish route (the server decides) and by the
// page load (the button only reflects the same answer), so the two cannot drift.
// No server imports: the page and the tests share it.

export type ApprovalRefusal = 'submitter' | 'author' | 'not-eligible'

export type ApprovalVerdict =
  | { ok: true }
  | { ok: false; reason: ApprovalRefusal; message: string }

export const APPROVAL_MESSAGES: Record<ApprovalRefusal, string> = {
  submitter:
    'Wer das Protokoll eingereicht hat, kann es nicht selbst freigeben. Eine zweite Person muss es freigeben und veröffentlichen.',
  author:
    'Wer das Protokoll angelegt hat, kann es nicht selbst freigeben. Eine zweite Person muss es freigeben und veröffentlichen.',
  'not-eligible':
    'Nur Admins und stimmberechtigte Mitglieder des Gremiums können ein Protokoll freigeben und veröffentlichen.',
}

export interface ApprovalSubject {
  readonly created_by: string | null
  /** NULL for a protocol submitted before the submitter was recorded. */
  readonly submitted_by: string | null
}

export interface ApprovalActor {
  readonly userId: string
  /** A customer admin (council-admin). */
  readonly isAdmin: boolean
  /** A voting member of the protocol's body. */
  readonly isVotingMember: boolean
}

/**
 * May `actor` approve (publish) this submitted protocol?
 *
 * Eligibility is checked first so an outsider is never told who submitted what.
 * A protocol submitted before the submitter was recorded has no submitter to
 * compare with; the creator rule still holds for it.
 */
export function evaluateApprover(subject: ApprovalSubject, actor: ApprovalActor): ApprovalVerdict {
  if (!actor.isAdmin && !actor.isVotingMember) {
    return { ok: false, reason: 'not-eligible', message: APPROVAL_MESSAGES['not-eligible'] }
  }
  if (subject.submitted_by && subject.submitted_by === actor.userId) {
    return { ok: false, reason: 'submitter', message: APPROVAL_MESSAGES.submitter }
  }
  if (subject.created_by && subject.created_by === actor.userId) {
    return { ok: false, reason: 'author', message: APPROVAL_MESSAGES.author }
  }
  return { ok: true }
}

/**
 * How many people other than the submitter and the creator could approve:
 * customer admins plus voting members of the body, each counted once. A body
 * where this is 0 cannot publish; the page says so instead of showing a button
 * nobody can press.
 */
export function countOtherEligible(
  subject: ApprovalSubject,
  adminIds: readonly string[],
  votingMemberIds: readonly string[],
): number {
  const eligible = new Set<string>([...adminIds, ...votingMemberIds])
  if (subject.submitted_by) eligible.delete(subject.submitted_by)
  if (subject.created_by) eligible.delete(subject.created_by)
  return eligible.size
}
