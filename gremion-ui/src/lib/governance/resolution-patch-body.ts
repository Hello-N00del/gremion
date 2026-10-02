// The PATCH body the protocol editor sends for one resolution (INV-5): the
// client never sends a free-hand binding `result` — the resolution-write route
// refuses `result: 'passed'|'rejected'` with a 400. 'withdrawn' is an author act
// (honoured); an acclamation row carries the chair's DECLARED outcome plus an
// optional all-or-none informational tally; a tallied vote sends only the
// tallies and the server recomputes. Rule and mode are pinned to the stored row
// server-side, so they are never re-sent. Shape from the source editor's
// saveResolution (d0c656d0), extracted so it is unit-tested (TASK-206-A).

export interface ResolutionPatchInput {
  text: string
  votes_yes: number | null
  votes_no: number | null
  votes_abstain: number | null
  result: 'passed' | 'rejected' | 'withdrawn'
  adoption_mode?: 'tally' | 'acclamation'
}

export function resolutionPatchBody(r: ResolutionPatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = { text: r.text }
  if (r.result === 'withdrawn') {
    patch.result = 'withdrawn'
  } else if (r.adoption_mode === 'acclamation') {
    patch.declared_result = r.result
    if (r.votes_yes != null && r.votes_no != null && r.votes_abstain != null) {
      patch.votes_yes = r.votes_yes
      patch.votes_no = r.votes_no
      patch.votes_abstain = r.votes_abstain
    }
  } else {
    patch.votes_yes = r.votes_yes
    patch.votes_no = r.votes_no
    patch.votes_abstain = r.votes_abstain
  }
  return patch
}
