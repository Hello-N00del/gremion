import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol, addResolution } from '$lib/server/protocols/protocol-db'
import type { AdoptionMode, RequiredMajority } from '$lib/server/protocols/protocol-db'
import { decideResolution } from '$lib/server/governance/resolution-decision'
import { DEFAULT_MAJORITY } from '$lib/server/governance/decision-rule'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function POST(event: RequestEvent) {
  requireAdmin(event)
  const protocol = await getProtocol(event.params.id!)
  if (!protocol || protocol.status === 'published') throw error(403, 'Nicht bearbeitbar')
  const body = await event.request.json()

  // T4 (#320 Phase 2): HOW the decision is reached — 'tally' (counted vote,
  // the default and the exact pre-existing behaviour) or 'acclamation'
  // (chair-declared result, no count).
  const adoptionMode: AdoptionMode = body.adoption_mode ?? body.adoptionMode ?? 'tally'
  if (adoptionMode !== 'tally' && adoptionMode !== 'acclamation') {
    throw error(400, "Ungültiger adoption_mode (erlaubt: 'tally' | 'acclamation')")
  }

  // INV-5: the binding result is NEVER accepted free-hand via `result` — in
  // tally mode the server computes it from rule + tallies, in acclamation mode
  // the chair's declaration travels in `declared_result`. The client `result`
  // field is consulted ONLY for 'withdrawn' (an author act, not a decision).
  if (body.result === 'passed' || body.result === 'rejected') {
    throw error(400, 'result wird serverseitig bestimmt (für Akklamation declared_result verwenden)')
  }

  // Widened to the persisted 5-rule vocabulary; the value flows unchanged to both
  // the live evaluator (decideResolution) and persistence (addResolution), so no
  // per-call-site `as` narrowing is needed. INV-5 membership is enforced by the
  // engine (UnknownDecisionRuleError) and the DB CHECK, not re-validated here.
  const requiredMajority = (body.requiredMajority ?? DEFAULT_MAJORITY) as RequiredMajority
  const decisionRuleParams: { fraction?: number } | null =
    body.decision_rule_params ?? body.decisionRuleParams ?? null
  // A parametrised rule must arrive WITH a VALID parameter: the rule is fixed at
  // creation (INV-5), so there is no later chance to supply it. Enforced ONLY for
  // tally rows — for acclamation the rule is inert (the server never evaluates it),
  // so an empty/omitted Anteil on an acclamation row is legal. Validate the range
  // here and return a clean 400, rather than letting an out-of-(0,1] or NaN
  // fraction reach the engine and surface as a 500 (InvalidDecisionRuleParamsError).
  if (adoptionMode === 'tally' && requiredMajority === 'support_threshold') {
    const fraction = decisionRuleParams?.fraction
    if (typeof fraction !== 'number' || Number.isNaN(fraction) || fraction <= 0 || fraction > 1) {
      throw error(400, "requiredMajority 'support_threshold' erfordert decision_rule_params.fraction in (0, 1]")
    }
  }

  if (adoptionMode === 'acclamation') {
    const declaredResult = body.declared_result ?? body.declaredResult
    if (declaredResult !== 'passed' && declaredResult !== 'rejected') {
      throw error(400, "Akklamation erfordert declared_result ('passed' | 'rejected')")
    }
    // Informational tally: all three counts or none — mirrors the DB
    // votes_mode CHECK, so a partial count can never reach the INSERT.
    const providedVotes = [body.votesYes, body.votesNo, body.votesAbstain]
      .filter((v) => v !== undefined && v !== null).length
    if (providedVotes !== 0 && providedVotes !== 3) {
      throw error(400, 'Informative Stimmzahlen entweder vollständig (Ja/Nein/Enthaltung) oder gar nicht angeben')
    }
    const resolution = await addResolution(protocol.id, {
      text: body.text ?? '',
      votesYes: providedVotes === 3 ? body.votesYes : null,
      votesNo: providedVotes === 3 ? body.votesNo : null,
      votesAbstain: providedVotes === 3 ? body.votesAbstain : null,
      result: declaredResult,
      requiredMajority,
      adoptionMode,
      decisionRuleParams,
    })
    return json({ resolution }, { status: 201 })
  }

  const votesYes = body.votesYes ?? 0
  const votesNo = body.votesNo ?? 0
  const votesAbstain = body.votesAbstain ?? 0

  // INV-5: the binding result is computed server-side from the pre-declared rule
  // + tallies — never accepted free-hand from the client. Quorum is enforced AT
  // ADOPTION (protocol publish), not during draft data-entry, so this write path
  // does not block a not-yet-quorate meeting (enforceQuorum: false).
  const decision = await decideResolution({
    protocolId: protocol.id,
    votesYes,
    votesNo,
    votesAbstain,
    requiredMajority,
    // T4↔T3 seam: a parametrised rule (support_threshold) carries its declared
    // params to the live evaluator, not just to persistence — otherwise the
    // registry strategy throws for a missing fraction. Undefined for the
    // parameterless core rules.
    params: decisionRuleParams ?? undefined,
    withdrawn: body.result === 'withdrawn',
    enforceQuorum: false,
  })

  const resolution = await addResolution(protocol.id, {
    text: body.text ?? '',
    votesYes,
    votesNo,
    votesAbstain,
    result: decision.result,
    requiredMajority,
    adoptionMode,
    decisionRuleParams,
  })
  return json({ resolution }, { status: 201 })
}
