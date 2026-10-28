// TRD-196 / PRD-OPS-005 — the whole seam, every in-tree module: kernel + calendar +
// board + elections + files + messaging + publishing + votes. The DB-backed
// hooks run against the real schema and the real report store; the hooks that
// front an external system (Nextcloud, Synapse, the newsletter service, Keycloak)
// are the real hooks wired to fakes of that system. Every data module erased,
// but the `identity` step (queued Keycloak/Matrix/Nextcloud group removals and
// the Keycloak account, identity-hook.ts) is `skipped` -> `incomplete`; one
// module that cannot reach its system -> failed/skipped, never `complete`.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '$lib/server/db'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { calendarErasureHook } from '$lib/server/calendar/erasure'
import { boardErasureHook } from '$lib/server/board/erasure'
import { electionsErasureHook } from '$lib/server/elections/erasure'
import { createFilesErasureHook } from '$lib/server/files/erasure'
import { NextcloudClient } from '$lib/server/files/nextcloud-client'
import { createMessagingErasureHook } from '$lib/server/messages/erasure'
import { createPublishingErasureHook } from '$lib/server/newsletter/erasure'
import { createVotesErasureHook } from '$lib/server/polls/erasure'
import { kernelErasureHook } from './kernel-hook'
import { createIdentityErasureHook } from './identity-hook'
import { runErasure, type ErasureDeps } from './orchestrator'
import { createPgReportStore, getErasureReport } from './report-store'

process.env.AUTH_SECRET ??= 'integration-test-auth-secret'

const TENANT = '01920000-0000-7000-8000-00000000aaaa'
const SUBJECT = '0b5f0e9c-3a56-4f3a-9a7a-1d8f0a2b7caa'
const MODULES = ['kernel', 'identity', 'calendar', 'board', 'elections', 'files', 'messaging', 'publishing', 'votes']

function externalHooks(opts: { keycloakAccountGone?: boolean } = {}): KernelErasureHook[] {
  const gone = opts.keycloakAccountGone === true
  return [
    createFilesErasureHook({ nc: () => ({ deleteUser: vi.fn().mockResolvedValue(true) }) }),
    createMessagingErasureHook({
      resolveLocalpart: async () => (gone ? null : 'jdoe'),
      synapse: () => ({ eraseUser: vi.fn().mockResolvedValue(true) }),
    }),
    createPublishingErasureHook({
      resolveEmail: async () => (gone ? null : 'anna@example.org'),
      backend: () => ({
        listMailingLists: async () => [{ id: 1, name: 'L', created_at: '' }],
        listMembers: async () => [{ id: 7, list_id: 1, email: 'anna@example.org', name: null, source: 'manual', created_at: '' }],
        deleteMember: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    createVotesErasureHook({ deleteAccount: vi.fn().mockResolvedValue(true) }),
  ] as KernelErasureHook[]
}

function deps(hooks: KernelErasureHook[]): ErasureDeps {
  const sql = getDb()
  const byId = new Map<string, KernelErasureHook>(
    [kernelErasureHook, createIdentityErasureHook(), calendarErasureHook, boardErasureHook, electionsErasureHook, ...hooks].map((h) => [h.moduleId, h as KernelErasureHook]),
  )
  return {
    enabledModuleIds: () => MODULES,
    hookFor: (id) => byId.get(id),
    connectionFor: () => sql,
    store: createPgReportStore(sql),
    now: () => new Date(),
  }
}

beforeEach(async () => {
  const sql = getDb()
  await sql`TRUNCATE erasure_report, provisioning_member_ops, governance_membership_record, org_units, calendar_events, notification_read_marker, role_assignment_history CASCADE`
  const [unit] = await sql<{ id: string }[]>`INSERT INTO org_units (name, kind) VALUES ('All-Gremium', 'committee') RETURNING id`
  await sql`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id) VALUES (${unit.id}, ${SUBJECT})`
  await sql`INSERT INTO provisioning_resources (org_unit_id, subsystem, external_id, status) VALUES (${unit.id}, 'keycloak', 'kc-g', 'ok')`
  await sql`INSERT INTO calendar_events (title, start_at, end_at, created_by) VALUES ('Sitzung', now(), now(), ${SUBJECT})`
  const [board] = await sql<{ id: string }[]>`INSERT INTO board (org_unit_id, name) VALUES (${unit.id}, 'B') RETURNING id`
  const [stack] = await sql<{ id: string }[]>`INSERT INTO stack (board_id, name) VALUES (${board.id}, 'S') RETURNING id`
  await sql`INSERT INTO card (stack_id, title, assignee_keycloak_id, created_by) VALUES (${stack.id}, 'C', ${SUBJECT}, ${SUBJECT})`
  await sql`INSERT INTO committee_elections (helios_uuid, org_unit_id, created_by) VALUES ('h-1', ${unit.id}, ${SUBJECT})`
})

describe('erasure across every in-tree module', () => {
  it('all eight data modules erased, identity removal still queued -> incomplete, no personal data left in the kernel DB', async () => {
    const report = await runErasure({ tenantId: TENANT, subjectId: SUBJECT, requestedBy: 'admin' }, deps(externalHooks()))
    expect(report.modules.map((m) => [m.moduleId, m.status])).toEqual(
      MODULES.map((id) => [id, id === 'identity' ? 'skipped' : 'erased']),
    )
    expect(report.modules[1].reason).toMatch(/external identity removal pending: 1 ops queued/)
    expect(report.status).toBe('incomplete')

    const stored = await getErasureReport(getDb(), TENANT, report.id)
    expect(stored?.status).toBe('incomplete')
    expect(stored?.modules.map((m) => m.moduleId)).toEqual(MODULES)

    const sql = getDb()
    expect(await sql`SELECT 1 FROM org_unit_members WHERE user_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM calendar_events WHERE created_by = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM card WHERE created_by = ${SUBJECT} OR assignee_keycloak_id = ${SUBJECT}`).toHaveLength(0)
    expect(await sql`SELECT 1 FROM committee_elections WHERE created_by::text = ${SUBJECT}`).toHaveLength(0)
    // the records themselves survive
    expect(await sql`SELECT 1 FROM calendar_events`).toHaveLength(1)
    expect(await sql`SELECT 1 FROM card`).toHaveLength(1)
    expect(await sql`SELECT 1 FROM committee_elections`).toHaveLength(1)
  })

  it('Keycloak account already gone: messaging and publishing skip honestly -> incomplete, never complete', async () => {
    const report = await runErasure({ tenantId: TENANT, subjectId: SUBJECT, requestedBy: 'admin' }, deps(externalHooks({ keycloakAccountGone: true })))
    const by = Object.fromEntries(report.modules.map((m) => [m.moduleId, m]))
    expect(by.messaging.status).toBe('skipped')
    expect(by.messaging.reason).toMatch(/Keycloak account/)
    expect(by.publishing.status).toBe('skipped')
    expect(by.board.status).toBe('erased')
    expect(report.status).toBe('incomplete')
    expect((await getErasureReport(getDb(), TENANT, report.id))?.status).toBe('incomplete')
  })

  it('a module whose external system fails is reported failed, the rest still run; the stored report never holds the subject id', async () => {
    // the REAL Nextcloud client: its error message carries the request path with the subject id
    vi.stubGlobal('fetch', async () => new Response(`boom for ${SUBJECT}`, { status: 500 }))
    try {
      const failing = createFilesErasureHook({ nc: () => new NextcloudClient('http://nc.test', 'admin', 'pw') })
      const hooks = [failing, ...externalHooks().slice(1)] as KernelErasureHook[]
      const report = await runErasure({ tenantId: TENANT, subjectId: SUBJECT, requestedBy: 'admin' }, deps(hooks))
      const by = Object.fromEntries(report.modules.map((m) => [m.moduleId, m]))
      expect(by.files).toMatchObject({ status: 'failed', reason: 'NextcloudResponseError (HTTP 500)' })
      expect(by.votes.status).toBe('erased')
      expect(report.status).toBe('incomplete')
      const rows = await getDb()`SELECT to_jsonb(m)::text AS j FROM erasure_report_module m`
      expect(rows.map((r) => r.j).join(' ')).not.toContain(SUBJECT)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
