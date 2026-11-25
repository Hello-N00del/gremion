import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { getProtocol, addResolution, ProtocolNotEditableError } from '$lib/server/protocols/protocol-db'
import type { AdoptionMode, ProtocolResolution, RequiredMajority } from '$lib/server/protocols/protocol-db'
import { requireUuidParams } from '$lib/server/protocols/route-ids'
import { requireResolutionText } from '$lib/server/protocols/resolution-text'
import { assertResolutionFitsMeeting, requireWholeNumberCounts } from '$lib/server/protocols/resolution-plausibility'
import { decideResolution } from '$lib/server/governance/resolution-decision'
import { getQuorumContext } from '$lib/server/governance/quorum'
import {
  CORE_DECISION_RULE_IDS,
  DEFAULT_MAJORITY,
  isCoreDecisionRuleId,
  isDecisionRuleInputError,
} from '$lib/server/governance/decision-rule'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

const NOT_EDITABLE_MESSAGE = 'Nicht bearbeitbar'

/**
 * The early check below is a read; a publish can commit between it and the
 * INSERT. The status guard inside addResolution's statement is what closes that
 * window and reports it as ProtocolNotEditableError: answer it like the early
 * check does (403), never as a 500 and never by adding to a published protocol.
 */
async function addToEditableProtocol(
  ...args: Parameters<typeof addResolution>
): Promise<ProtocolResolution> {
  try {
    return await addResolution(...args)
  } catch (err) {
    if (err instanceof ProtocolNotEditableError) throw error(403, NOT_EDITABLE_MESSAGE)
    throw err
  }
}

export async function POST(event: RequestEvent) {
  requireAdmin(event)
  requireUuidParams(event, 'id')
  const protocol = await getProtocol(event.params.id!)
  if (!protocol || protocol.status === 'published') throw error(403, NOT_EDITABLE_MESSAGE)
  const body = await event.request.json()
  // A decision is stored only with its text (editor: entry form, not an empty row).
  const text = requireResolutionText(body.text)

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
  // the live evaluator (decideResolution) and persistence (addResolution).
  // Validated here against the five ids the required_majority CHECK accepts
  // (migration 0054), in BOTH modes: an unknown id is client input, a 400 —
  // never an engine UnknownDecisionRuleError or a CHECK violation surfacing as 500.
  const requestedRule: unknown = body.requiredMajority ?? DEFAULT_MAJORITY
  if (!isCoreDecisionRuleId(requestedRule)) {
    throw error(400, `Unbekannte Abstimmungsregel (erlaubt: ${CORE_DECISION_RULE_IDS.join(', ')})`)
  }
  const requiredMajority: RequiredMajority = requestedRule
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
    // An informational count is a JSON number, like a tally: the integer column never
    // sees a client string.
    requireWholeNumberCounts(body.votesYes, body.votesNo, body.votesAbstain)
    // The declared outcome is a decision of the meeting like a counted one: a
    // meeting that is not quorate records none, and an informational count still
    // has to fit the members present.
    assertResolutionFitsMeeting(
      {
        required_majority: requiredMajority,
        adoption_mode: 'acclamation',
        votes_yes: providedVotes === 3 ? body.votesYes : null,
        votes_no: providedVotes === 3 ? body.votesNo : null,
        votes_abstain: providedVotes === 3 ? body.votesAbstain : null,
      },
      await getQuorumContext(protocol.id),
    )
    const resolution = await addToEditableProtocol(protocol.id, {
      text,
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
  // + tallies — never accepted free-hand from the client. The engine is asked for
  // the result without its own quorum throw (enforceQuorum: false) because a row
  // nobody has voted on yet is a placeholder that a not-yet-quorate meeting may
  // hold; every other decision is checked below against the same quorum context
  // the engine read (assertResolutionFitsMeeting), and publish enforces quorum
  // again at adoption.
  // A malformed tally (negative, fractional, non-numeric) is client input: the
  // engine's typed errors become a 400 instead of escaping as a 500.
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
  }).catch((err: unknown) => {
    if (isDecisionRuleInputError(err)) throw error(400, `Ungültige Abstimmungsdaten: ${err.message}`)
    throw err
  })

  // quorum is null only for a withdrawn resolution, which is no vote.
  if (decision.quorum) {
    assertResolutionFitsMeeting(
      {
        required_majority: requiredMajority,
        adoption_mode: 'tally',
        votes_yes: votesYes,
        votes_no: votesNo,
        votes_abstain: votesAbstain,
      },
      decision.quorum,
    )
  }

  const resolution = await addToEditableProtocol(protocol.id, {
    text,
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
