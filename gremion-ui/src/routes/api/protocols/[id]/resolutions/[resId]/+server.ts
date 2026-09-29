import { error, json } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth'
import { updateResolution, deleteResolution } from '$lib/server/protocols/protocol-db'
import type { AdoptionMode, RequiredMajority } from '$lib/server/protocols/protocol-db'
import { getDb } from '$lib/server/db'
import { decideResolution } from '$lib/server/governance/resolution-decision'

function requireAdmin(event: RequestEvent): SessionUser {
  const user = event.locals.user as SessionUser | undefined
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins')
  return user
}

export async function PATCH(event: RequestEvent) {
  requireAdmin(event)
  const body = await event.request.json()
  const sql = getDb()
  const [current] = await sql<{
    protocol_id: string
    votes_yes: number | null
    votes_no: number | null
    votes_abstain: number | null
    required_majority: RequiredMajority
    adoption_mode: AdoptionMode
    decision_rule_params: { fraction?: number } | null
  }[]>`SELECT protocol_id, votes_yes, votes_no, votes_abstain, required_majority, adoption_mode, decision_rule_params
       FROM protocol_resolutions WHERE id = ${event.params.resId!}`
  if (!current) throw error(404, 'Beschluss nicht gefunden')

  // INV-5 (T4, mirror of the POST gate): the binding result is never accepted
  // free-hand on an edit either — an acclamation edit uses declared_result;
  // `result` is consulted ONLY for 'withdrawn'.
  if (body.result === 'passed' || body.result === 'rejected') {
    throw error(400, 'result wird serverseitig bestimmt (für Akklamation declared_result verwenden)')
  }

  // INV-5: the decision rule AND the adoption procedure are FIXED at creation.
  // An edit never changes them — always work against the values stored on the
  // row, ignoring any client `requiredMajority` / `adoption_mode`, so an admin
  // cannot retroactively pick a rule or mode to flip the outcome after the fact.
  const requiredMajority: RequiredMajority = current.required_majority

  if (current.adoption_mode === 'acclamation') {
    // 'withdrawn' is an author act, honoured IDENTICALLY in both modes — it
    // overrides the chair's declared outcome, exactly as the tally branch returns
    // 'withdrawn' from decideResolution regardless of the tally. Previously the
    // acclamation branch ignored it, so the UI's "Zurückziehen" (which sends
    // { result: 'withdrawn' } for acclamation rows too) was a silent no-op. To
    // un-withdraw, send a fresh declared_result — the mirror of the tally branch's
    // "edit the tallies to recompute" un-withdraw path.
    if (body.result === 'withdrawn') {
      const resolution = await updateResolution(event.params.resId!, {
        text: body.text,
        result: 'withdrawn',
        requiredMajority,
      })
      return json({ resolution })
    }
    const declaredResult = body.declared_result ?? body.declaredResult
    if (declaredResult !== undefined && declaredResult !== 'passed' && declaredResult !== 'rejected') {
      throw error(400, "declared_result muss 'passed' oder 'rejected' sein")
    }
    // Informational tally: all three counts or none (DB votes_mode CHECK mirror).
    const votesYes = body.votes_yes ?? body.votesYes
    const votesNo = body.votes_no ?? body.votesNo
    const votesAbstain = body.votes_abstain ?? body.votesAbstain
    const providedVotes = [votesYes, votesNo, votesAbstain]
      .filter((v) => v !== undefined && v !== null).length
    if (providedVotes !== 0 && providedVotes !== 3) {
      throw error(400, 'Informative Stimmzahlen entweder vollständig (Ja/Nein/Enthaltung) oder gar nicht angeben')
    }
    const resolution = await updateResolution(event.params.resId!, {
      text: body.text,
      ...(providedVotes === 3 ? { votesYes, votesNo, votesAbstain } : {}),
      ...(declaredResult !== undefined ? { result: declaredResult } : {}),
      requiredMajority,
    })
    return json({ resolution })
  }

  const votesYes = body.votes_yes ?? body.votesYes ?? current.votes_yes ?? 0
  const votesNo = body.votes_no ?? body.votesNo ?? current.votes_no ?? 0
  const votesAbstain = body.votes_abstain ?? body.votesAbstain ?? current.votes_abstain ?? 0

  // Fraction range guard (mirror of the POST boundary): a support_threshold row
  // recomputes against its STORED fraction. Should that fraction ever be out of
  // (0, 1] or NaN (e.g. a legacy/corrupt row), return a clean 400 rather than
  // letting the engine throw InvalidDecisionRuleParamsError → 500.
  if (requiredMajority === 'support_threshold') {
    const fraction = current.decision_rule_params?.fraction
    if (typeof fraction !== 'number' || Number.isNaN(fraction) || fraction <= 0 || fraction > 1) {
      throw error(400, "Gespeicherte decision_rule_params.fraction ungültig (erwartet: Zahl in (0, 1])")
    }
  }

  // INV-5: recompute the binding result server-side from the (possibly patched)
  // tallies + the fixed rule. Quorum is enforced AT ADOPTION (publish), not on a
  // draft edit, so this path does not block a not-yet-quorate meeting.
  const decision = await decideResolution({
    protocolId: current.protocol_id,
    votesYes,
    votesNo,
    votesAbstain,
    requiredMajority,
    // T4↔T3 seam: a support_threshold row recomputes against the params FIXED
    // at creation (stored on the row), never a client-supplied fraction — the
    // rule and its params are immutable post-creation (INV-5).
    params: current.decision_rule_params ?? undefined,
    withdrawn: body.result === 'withdrawn',
    enforceQuorum: false,
  })

  const resolution = await updateResolution(event.params.resId!, {
    text: body.text,
    votesYes,
    votesNo,
    votesAbstain,
    result: decision.result,
    requiredMajority,
  })
  return json({ resolution })
}

export async function DELETE(event: RequestEvent) {
  requireAdmin(event)
  await deleteResolution(event.params.resId!)
  return new Response(null, { status: 204 })
}
