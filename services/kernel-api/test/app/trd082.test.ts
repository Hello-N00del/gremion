// TDD 11 (TRD-082, Q12): every tenancy / registry / migrate-job query the
// kernel API issues carries the customer id, except the pinned exemptions
// (1: the whole-host lookup, 3: the migrate job's tenant iteration). The REAL
// store modules run here over recording Sqls (the scratch-stack suite re-runs
// the recorder against PG18). RED: an unscoped query, a stale or unmatched
// exemption, zero queries scanned.
import { describe, expect, it } from 'vitest'
import { migrateAllCustomers } from '../../src/migrate/migrate.ts'
import { platformRegistryStore } from '../../src/registry/store.ts'
import { controlTenancyStore } from '../../src/tenancy/store.ts'
import { A_HOST, A_ID, appWith, B_HOST, B_ID, edge, world } from '../harness/fakes.ts'
import { PINNED_EXEMPTIONS, recordingSql, scopeProblems, type RecordedQuery } from '../harness/query-recorder.ts'

const ROWS: Record<string, Record<string, string>> = {
  [A_ID]: { id: A_ID, slug: 'a', status: 'active', realm_name: 'realm-a', issuer: 'https://a/realms/a', kc_internal: 'http://kc/realms/a', db_conn_ref: 'env:X' },
  [B_ID]: { id: B_ID, slug: 'council-b', status: 'active', realm_name: 'realm-b', issuer: 'https://b/realms/b', kc_internal: 'http://kc/realms/b', db_conn_ref: 'env:Y' },
}
const HOSTS: Record<string, string> = { [A_HOST]: A_ID, [B_HOST]: B_ID }

describe('TRD-082 query scoping (TDD 11)', () => {
  it('every query of a request round (host path, module caller, registry) and of the migrate job is customer-scoped or pinned', async () => {
    const records: RecordedQuery[] = []
    const control = recordingSql(records, (q) => {
      if (q.text.includes('d.host = $1')) {
        const id = HOSTS[q.params[0] as string]
        return id ? [ROWS[id]] : []
      }
      if (q.text.includes('ORDER BY t.id')) return Object.values(ROWS).map((r) => ({ id: r.id, status: r.status }))
      return ROWS[q.params[0] as string] ? [ROWS[q.params[0] as string]] : []
    })
    const platform = recordingSql(records, (q) => (q.text.includes('SELECT 1') ? [{ '?column?': 1 }] : [{ module_key: 'calendar', semver: '1.0.0' }]))
    const { app } = appWith(world(), { tenancy: controlTenancyStore(control), registry: platformRegistryStore(platform) })
    for (const [host, token] of [
      [A_HOST, 'token-a'],
      [B_HOST, 'token-b'],
    ] as const) {
      expect((await app.inject({ url: '/api/v1/modules', headers: edge(host, token) })).statusCode).toBe(200)
      expect((await app.inject({ url: '/api/v1/tenancy/self', headers: edge(host, token) })).statusCode).toBe(200)
    }
    const caller = { host: 'kernel-api:3000', 'x-gremion-module': 'calendar', 'x-internal-auth': 'calendar-module-secret-0123456789', 'x-tenant-id': A_ID }
    expect((await app.inject({ url: '/api/v1/tenancy/self', headers: caller })).statusCode).toBe(200)
    await app.close()

    // the migrate job: iterates every customer (exemption 3), then reads each by id
    const result = await migrateAllCustomers({
      control,
      resolveSecret: () => 'postgres://k:p@db:5432/x',
      directBase: 'postgres://db:5432/postgres',
      dirs: [],
      kernelRoot: '',
      releaseRef: 'dist-v1.0.0',
      dumpDir: undefined,
      log: () => {},
      audit: () => {},
    })
    // (each customer then fails on its target -- a wrong database -- which is beside the point here)
    expect(result.failed).toHaveLength(2)

    expect(records.length).toBeGreaterThanOrEqual(10)
    expect(scopeProblems(records, [A_ID, B_ID])).toEqual([])
    // the registry query names the customer it was asked for, never another
    const registryQueries = records.filter((r) => r.text.includes('plt.module_enablement'))
    expect(registryQueries.length).toBeGreaterThanOrEqual(3)
    for (const q of registryQueries) expect(q.text).toMatch(/e\.customer_id = \$1::uuid AND/)
  })

  it('RED: an unscoped registry query ("all modules", no customer predicate) is reported', () => {
    const rec: RecordedQuery[] = [
      { text: 'SELECT m.module_key FROM plt.module m', params: [] },
      { text: 'SELECT t.id::text AS id, t.slug, t.status, t.realm_name, t.issuer, t.kc_internal, t.db_conn_ref FROM public.tenant_domain d JOIN public.tenant t ON t.id = d.tenant_id WHERE d.host = $1', params: [A_HOST] },
      { text: 'SELECT t.id::text AS id, t.status FROM public.tenant t ORDER BY t.id', params: [] },
    ]
    expect(scopeProblems(rec, [A_ID])).toEqual(['unscoped query (no customer id among its parameters): SELECT m.module_key FROM plt.module m'])
  })

  it('RED: a stale exemption (nothing matched it) and zero scanned are reported', () => {
    expect(scopeProblems([], [A_ID])).toEqual(expect.arrayContaining(['0 queries scanned: the check would pass vacuously', `stale exemption (no query matched it): ${PINNED_EXEMPTIONS[0]!.id}`]))
  })

  it("RED: a query scoped to ANOTHER customer's id does not count as scoped for this one", () => {
    const rec: RecordedQuery[] = [{ text: 'SELECT 1 FROM plt.module_enablement e WHERE e.customer_id = $1::uuid', params: [B_ID] }]
    expect(scopeProblems(rec, [A_ID], [])).toEqual([expect.stringMatching(/^unscoped query/)])
  })

  it('exemption 2 (077-a catalogue upserts) is void: the pinned list holds exactly 1 and 3 (R10)', () => {
    expect(PINNED_EXEMPTIONS.map((e) => e.id.split(':')[0])).toEqual(['1', '3'])
  })
})
