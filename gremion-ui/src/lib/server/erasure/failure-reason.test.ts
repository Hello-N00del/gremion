// @vitest-environment node
//
// R33f HIGH: the failure reason of a module is stored in the APPEND-ONLY report
// (erasure_report_module_guard refuses UPDATE/DELETE once the run is finished), so
// it must never carry the subject id, the Matrix username or the e-mail. The REAL
// error types of the external clients put them in their message: the Nextcloud
// client's path holds the Keycloak id, Synapse's holds @<username>:<server>.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.AUTH_SECRET ??= 'unit-test-auth-secret'

vi.mock('$lib/server/env/service-env', async () => {
  const { env } = await import('$env/dynamic/private')
  return { serviceEnv: (name: string) => (env as Record<string, string | undefined>)[name] }
})
vi.mock('$env/dynamic/private', () => ({
  env: { MATRIX_URL: 'http://matrix.test:8008', SYNAPSE_ADMIN_TOKEN: 'admin-token', SYNAPSE_SERVER_NAME: 'matrix.test' },
}))

import type { Sql } from '@gremion/db'
import type { ModuleErasureOutcome } from '@gremion/ports/erasure'
import { NextcloudClient } from '$lib/server/files/nextcloud-client'
import { createFilesErasureHook } from '$lib/server/files/erasure'
import { createMessagingErasureHook } from '$lib/server/messages/erasure'
import { getSynapseAdmin, __resetSynapseAdminForTests } from '$lib/server/messages/synapse-admin'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import type { KernelErasureHook } from '$lib/server/modules/runtime-registry'
import { runErasure, type ErasureDeps, type ErasureReportStore } from './orchestrator'

const CTX = { id: 'tid-reason', slug: 'reason' } as unknown as TenantContext
const SUBJECT = '0b5f0e9c-3a56-4f3a-9a7a-1d8f0a2b7caa'
const USERNAME = 'anna.musterfrau'
const EMAIL = 'anna.musterfrau@example.org'

function store(outcomes: ModuleErasureOutcome[], finished: { reason?: string | null }[]): ErasureReportStore {
  return {
    begin: async () => 'r1',
    record: async (_id, o) => void outcomes.push(o),
    finish: async (_id, _s, _at, reason) => void finished.push({ reason }),
    sweepStale: async () => 0,
  }
}

function deps(hooks: KernelErasureHook[], s: ErasureReportStore): ErasureDeps {
  const byId = new Map(hooks.map((h) => [h.moduleId, h]))
  return {
    enabledModuleIds: () => hooks.map((h) => h.moduleId),
    hookFor: (id) => byId.get(id),
    connectionFor: () => ({}) as Sql,
    resolveSubject: async (id) => ({ id, username: USERNAME, email: EMAIL }),
    store: s,
    now: () => new Date('2026-10-28T10:00:00Z'),
  }
}

const run = (hooks: KernelErasureHook[], outcomes: ModuleErasureOutcome[]) =>
  runWithTenant(CTX, () =>
    runErasure({ tenantId: 'tid-reason', subjectId: SUBJECT, requestedBy: 'admin' }, deps(hooks, store(outcomes, []))),
  )

function leaks(text: string | null): string[] {
  return [SUBJECT, USERNAME, EMAIL, encodeURIComponent(`@${USERNAME}:matrix.test`)].filter((s) => (text ?? '').includes(s))
}

beforeEach(() => __resetSynapseAdminForTests())
afterEach(() => vi.unstubAllGlobals())

describe('stored failure reasons never carry the subject identity', () => {
  it('real NextcloudResponseError (path holds the Keycloak id): files is failed, reason clean', async () => {
    vi.stubGlobal('fetch', async () => new Response(`internal error for user ${SUBJECT}`, { status: 503 }))
    const files = createFilesErasureHook({ nc: () => new NextcloudClient('http://nc.test', 'admin', 'pw') })
    const outcomes: ModuleErasureOutcome[] = []
    const report = await run([files as KernelErasureHook], outcomes)
    expect(report.modules[0].status).toBe('failed')
    expect(leaks(report.modules[0].reason)).toEqual([])
    expect(outcomes[0].reason).toMatch(/503/)
    expect(leaks(outcomes[0].reason)).toEqual([])
  })

  it('real SynapseError (path holds @username:server, body echoes it): messaging is failed, reason clean', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ errcode: 'M_UNKNOWN', error: `cannot deactivate @${USERNAME}:matrix.test` }), { status: 500 }),
    )
    const messaging = createMessagingErasureHook({
      resolveLocalpart: async () => USERNAME,
      synapse: () => getSynapseAdmin(),
    })
    const outcomes: ModuleErasureOutcome[] = []
    const report = await run([messaging as KernelErasureHook], outcomes)
    expect(report.modules[0].status).toBe('failed')
    expect(outcomes[0].reason).toMatch(/500/)
    expect(leaks(outcomes[0].reason)).toEqual([])
  })

  it('a plain Error that quotes the id, the username and the e-mail is stored without them', async () => {
    const boom: KernelErasureHook = {
      moduleId: 'calendar',
      erase: async () => {
        throw new Error(`failed for ${SUBJECT} / ${USERNAME} / ${EMAIL}`)
      },
    }
    const outcomes: ModuleErasureOutcome[] = []
    await run([boom], outcomes)
    expect(outcomes[0].status).toBe('failed')
    expect(leaks(outcomes[0].reason)).toEqual([])
  })

  it('a transient database error that quotes the id is stored without it', async () => {
    const down: KernelErasureHook = {
      moduleId: 'calendar',
      erase: async () => {
        throw Object.assign(new Error(`connect ECONNREFUSED while erasing ${SUBJECT}`), { code: 'ECONNREFUSED' })
      },
    }
    const outcomes: ModuleErasureOutcome[] = []
    await run([down], outcomes)
    expect(outcomes[0].status).toBe('skipped')
    expect(leaks(outcomes[0].reason)).toEqual([])
  })

  it('the finish reason of an aborted run is redacted too', async () => {
    const finished: { reason?: string | null }[] = []
    const s = store([], finished)
    s.record = async () => {
      throw new Error(`insert failed for ${SUBJECT}`)
    }
    const ok: KernelErasureHook = { moduleId: 'calendar', erase: async () => ({ status: 'erased', counts: {} }) }
    await expect(
      runWithTenant(CTX, () => runErasure({ tenantId: 'tid-reason', subjectId: SUBJECT, requestedBy: 'admin' }, deps([ok], s))),
    ).rejects.toThrow()
    expect(finished[0].reason).toMatch(/run aborted/)
    expect(leaks(finished[0].reason ?? '')).toEqual([])
  })
})
