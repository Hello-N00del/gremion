import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { listOrgUnitMembers } from '$lib/server/governance/org-units-db'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'

type AttendanceStatus = 'present' | 'absent' | 'excused'

interface RosterAttendance {
  user_id: string
  status: AttendanceStatus
  displayName: string
}

export const load: PageServerLoad = async ({ params, fetch, locals, parent }) => {
  const user = locals.user
  if (!user) throw error(401, 'Unauthenticated')
  // R29-F104-KTWIN (D-3): the committee layout holds the visibility gate for the
  // URL unit. Await it BEFORE any read: on a __data.json request that skips the
  // layout, only parent() makes its 404 abort this load before the roster read.
  await parent()

  const res = await fetch(`/api/protocols/${params.protocolId}`)
  if (!res.ok) throw error(res.status, 'Protokoll nicht gefunden')
  const { protocol, attendance, resolutions, actionItems } = await res.json()
  // R29-F104-KTWIN (D-3): the roster below is read by the URL's committee id,
  // so the protocol must belong to that committee. Otherwise a readable protocol
  // of one unit would carry another unit's roster (the layout gate judges the
  // URL unit, the /api/protocols/[id] gate judges the protocol's).
  if (protocol?.committee_id !== params.id) throw error(404, 'Protokoll nicht gefunden')

  // INV-5 attendance capture: merge the committee ROSTER (org_unit_members) with
  // whatever attendance has been recorded so far, so every member appears as a
  // chip — even before anyone touched their status (left join: roster ⟕
  // protocol_attendance, default 'absent'). Voting members feed the quorum count;
  // non-voting members (sachkundige Bürger, §3.5(d)) are listed separately as
  // 'beratend (nicht stimmberechtigt)' and never count toward quorum.
  const members = await listOrgUnitMembers(params.id)

  const recorded = new Map<string, AttendanceStatus>(
    (attendance as { user_keycloak_id: string; status: AttendanceStatus }[]).map((a) => [
      a.user_keycloak_id,
      a.status,
    ]),
  )

  // Names are resolved live from Keycloak — never cached in the DB (GDPR §7).
  // Mirrors the committee detail page's resolver; a lookup miss degrades to the
  // raw id rather than throwing.
  const nameMap: Record<string, string> = {}
  await Promise.allSettled(
    members.map(async (m) => {
      try {
        const kc = await getKeycloakAdminClient(locals.tenant).getUser(m.user_keycloak_id)
        nameMap[m.user_keycloak_id] =
          [kc.firstName, kc.lastName].filter(Boolean).join(' ') || kc.username
      } catch {
        nameMap[m.user_keycloak_id] = m.user_keycloak_id
      }
    }),
  )

  const toEntry = (m: (typeof members)[number]): RosterAttendance => ({
    user_id: m.user_keycloak_id,
    status: recorded.get(m.user_keycloak_id) ?? 'absent',
    displayName: nameMap[m.user_keycloak_id] ?? m.user_keycloak_id,
  })

  const votingAttendance = members.filter((m) => m.voting).map(toEntry)
  const advisoryAttendance = members.filter((m) => !m.voting).map(toEntry)

  // INV-5 quorum (preset rule): a strict majority of eligible VOTING members must
  // be present. Mirrors getQuorumContext's `present*2 > eligible`; surfaced before
  // publish as the quorum pill.
  const eligibleVotingCount = votingAttendance.length
  const presentVotingCount = votingAttendance.filter((e) => e.status === 'present').length
  const quorum = {
    eligibleVotingCount,
    presentVotingCount,
    quorate: eligibleVotingCount > 0 && presentVotingCount * 2 > eligibleVotingCount,
  }

  let wopiToken: { editorUrl: string; tokenTtl: number } | null = null
  if (protocol.status === 'draft') {
    const tokenRes = await fetch(`/api/protocols/${params.protocolId}/wopi-token`)
    if (tokenRes.ok) wopiToken = await tokenRes.json()
  }

  const pendingRes = await fetch(`/api/protocols?committeeId=${params.id}&status=submitted`)
  const pendingRaw = pendingRes.ok ? (await pendingRes.json()).protocols : []
  const pendingApprovals = pendingRaw.filter((p: { id: string }) => p.id !== params.protocolId)

  return {
    protocol,
    attendance: votingAttendance,
    advisoryAttendance,
    quorum,
    resolutions,
    actionItems,
    wopiToken,
    pendingApprovals,
    committeeId: params.id,
  }
}
