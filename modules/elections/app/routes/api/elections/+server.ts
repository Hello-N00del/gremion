import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  HeliosClient,
  HeliosAppError,
  HeliosUnavailableError,
  HeliosServiceAuthError,
  isHeliosUnavailable,
  deriveLifecycle,
  type HeliosElection,
} from '$lib/server/elections/helios-client'
import { ElectionDb } from '$lib/server/elections/election-db'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { listOrgUnitMembers } from '$lib/server/governance/org-units-db'
import type { ApiResponse } from '$lib/api-response'
import { parseJsonBody } from '$lib/server/parse-json-body'

export interface ElectionListItem {
  uuid: string
  name: string
  description: string
  votingStartsAt: string | null
  votingEndsAt: string | null
  numCastVotes: number
  lifecycle: 'draft' | 'open' | 'closed'
  committeeId: string
  calendarLinked: boolean
}

function toListItem(
  e: HeliosElection,
  committeeId: string,
  calendarLinked: boolean,
): ElectionListItem {
  return {
    uuid: e.uuid,
    name: e.name,
    description: e.description,
    votingStartsAt: e.voting_starts_at,
    votingEndsAt: e.voting_ends_at,
    numCastVotes: e.num_cast_votes,
    lifecycle: deriveLifecycle(e),
    committeeId,
    calendarLinked,
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' } satisfies ApiResponse<never>, { status: 403 })
  }

  const isAdmin = hasRole(user.roles, Role.CouncilAdmin)

  // Admins see all elections; members see elections for org-units they belong to.
  const rows = isAdmin
    ? await ElectionDb.findAll()
    : await ElectionDb.findVisibleToUser(user.id)

  const results = await Promise.allSettled(
    rows.map((row) => HeliosClient.getElection(row.helios_uuid)),
  )

  const items: ElectionListItem[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      items.push(toListItem(r.value, rows[i].org_unit_id, rows[i].calendar_linked))
    }
  }

  return json({ success: true, data: items } satisfies ApiResponse<ElectionListItem[]>)
}

interface CreateWizardBody {
  title: string
  shortName: string
  description: string
  committeeId: string
  votingStartsAt: string
  votingEndsAt: string
  questions: {
    question: string
    shortName: string
    answers: string[]
    min: number
    max: number
  }[]
  removedVoterEmails: string[]
  extraVoters?: { email: string; name: string }[]
  createCalendarEvents: boolean
  freeze: boolean
}

// Map a failure anywhere in the create flow to a specific, structured response.
// Before #153 the post-create steps were unguarded, so any failure surfaced as
// an opaque 500 the UI showed as "connection error". Each class is now distinct:
//  - service account missing/unprivileged → 503 (operator action needed)
//  - Helios application error (e.g. duplicate short_name) → 422
//  - Helios unreachable / network failure → 502
//  - anything else → 502 with a generic message (details logged server-side)
function heliosErrorResponse(err: unknown): Response {
  if (err instanceof HeliosServiceAuthError) {
    return json(
      { success: false, error: 'Helios-Dienstkonto ist nicht konfiguriert. Bitte Administrator kontaktieren.' } satisfies ApiResponse<never>,
      { status: 503 },
    )
  }
  if (err instanceof HeliosAppError) {
    return json({ success: false, error: err.message } satisfies ApiResponse<never>, { status: 422 })
  }
  if (err instanceof HeliosUnavailableError || isHeliosUnavailable(err)) {
    return json(
      { success: false, error: 'Helios nicht erreichbar. Bitte erneut versuchen.' } satisfies ApiResponse<never>,
      { status: 502 },
    )
  }
  return json(
    { success: false, error: 'Wahl konnte nicht angelegt werden. Bitte erneut versuchen.' } satisfies ApiResponse<never>,
    { status: 502 },
  )
}

export const POST: RequestHandler = async ({ request, locals, fetch }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' } satisfies ApiResponse<never>, { status: 403 })
  }
  if (!hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' } satisfies ApiResponse<never>, { status: 403 })
  }

  const raw = await parseJsonBody(request)
  // A malformed/missing body (or one without the required questions array)
  // returns a clean 400 instead of throwing a 500 when body.questions.map(...)
  // is dereferenced below. The cast is retained for the remaining fields so the
  // success-path behaviour is unchanged.
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as { questions?: unknown }).questions)) {
    return json({ success: false, error: 'Ungültige Anfrage' } satisfies ApiResponse<never>, { status: 400 })
  }
  const body = raw as CreateWizardBody

  // Steps 1-5 run as one guarded unit: a failure in any step — including the
  // service-account login inside the first Helios call — maps to a specific
  // structured response (see heliosErrorResponse) instead of an opaque 500 the
  // UI shows as "connection error" (#153).
  let election: HeliosElection
  try {
    // 1. Create election in Helios
    election = await HeliosClient.createElection({
      short_name: body.shortName,
      name: body.title,
      description: body.description,
      voting_starts_at: body.votingStartsAt,
      voting_ends_at: body.votingEndsAt,
    })

    // 2. Write the committee_elections row immediately (#185). Helios exposes no
    // delete API, so if a later step fails we cannot remove the Helios election;
    // recording it now makes the orphan a VISIBLE draft (GET lists it) the admin
    // can resume, not an invisible one a retry would silently duplicate.
    await ElectionDb.insert({
      heliosUuid: election.uuid,
      orgUnitId: body.committeeId,
      createdBy: user.id,
      calendarLinked: false,
    })
    // (If this insert itself fails, the Helios election has no local row and
    // cannot be resumed from the UI; the uuid is in the error log above for an
    // admin to reconcile manually — Helios has no delete API to roll it back.)

    // 3. Set questions
    await HeliosClient.setQuestions(
      election.uuid,
      body.questions.map((q) => ({
        question: q.question,
        short_name: q.shortName,
        answer_type: 'approval' as const,
        answers: q.answers,
        min: q.min,
        max: q.max,
      })),
    )

    // 4. Upload voters (org-unit members minus removed, plus any extra voters)
    const kc = getKeycloakAdminClient(locals.tenant)
    const orgUnitMembers = await listOrgUnitMembers(body.committeeId)
    const removedSet = new Set(body.removedVoterEmails)
    const committeeVoters: { email: string; name: string }[] = []
    for (const member of orgUnitMembers) {
      try {
        const kcUser = await kc.getUser(member.user_keycloak_id)
        const email = kcUser.email ?? ''
        if (!email || removedSet.has(email)) continue
        committeeVoters.push({
          email,
          name: `${kcUser.firstName ?? ''} ${kcUser.lastName ?? ''}`.trim(),
        })
      } catch {
        // One failed Keycloak lookup does not abort election creation — skip that member
      }
    }

    // Merge extra voters, deduplicating by email
    const emailsSeen = new Set(committeeVoters.map((v) => v.email))
    const extraVoters = (body.extraVoters ?? []).filter((v) => v.email && !emailsSeen.has(v.email))
    const allVoters = [...committeeVoters, ...extraVoters]

    await HeliosClient.bulkUploadVoters(election.uuid, allVoters)

    // 5. Freeze if requested
    if (body.freeze) {
      await HeliosClient.freeze(election.uuid)
    }

  } catch (err) {
    // After step 1 the Helios election (and after step 2 its local row) may
    // already exist; a failure here leaves a visible draft the admin can resume
    // rather than an invisible orphan. Helios exposes no delete API, so we log
    // and return a specific, actionable error rather than swallow it.
    console.error('[api/elections] create flow failed:', err)
    return heliosErrorResponse(err)
  }

  // 6. Trigger calendar automation if requested
  if (body.createCalendarEvents) {
    try {
      const res = await fetch('/api/calendar/automations/helios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          electionId: election.uuid,
          name: election.name,
          committeeId: body.committeeId,
          votingStartsAt: body.votingStartsAt,
          votingEndsAt: body.votingEndsAt,
        }),
      })
      if (res.ok) {
        await ElectionDb.markCalendarLinked(election.uuid)
      }
    } catch {
      // Non-fatal — calendar automation failure does not roll back the election
    }
  }

  return json(
    { success: true, data: { uuid: election.uuid } } satisfies ApiResponse<{ uuid: string }>,
    { status: 201 },
  )
}
