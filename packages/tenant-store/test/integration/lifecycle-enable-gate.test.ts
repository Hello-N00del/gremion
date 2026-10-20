// TASK-044 on the scratch stack (PG18, the harness's two servers):
//   TDD 1  the platform schema 0006-0008: CHECKs, append-only, the DPIA
//          document rule, the NOT VALID isolation keys as the DB backstop
//          (TRD-063: 23503 for a failed / foreign / unknown result, 23514 for
//          null references);
//   TDD 2  (lane note A4) the interim gate's shape -- whatever ids it is handed
//          -- ENABLES a real pass of ANOTHER tip and a DPIA id with no row;
//          createEnableGate refuses both, no database, not enabled, reason given;
//   TDD 3  every gate code over real rows;
//   TDD 5  importing verify evidence: round trip, dedupe, unknown module,
//          two concurrent imports -> one row;
//   TDD 9 + A3  an interim (attested) enablement survives the migration with
//          the keys NOT VALID, is named by unprovenEnablements, re-gated, and
//          the keys then VALIDATE.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  attestedEnablements,
  createEnableGate,
  enableModule,
  EnableRefused,
  IsolationEvidenceError,
  migratePlatform,
  PLATFORM_DATABASE,
  PLATFORM_MIGRATIONS_DIR,
  recordDpiaDecision,
  recordIsolationResults,
  regateEnablement,
  unprovenEnablements,
  validateGateForeignKeys,
  type EnableGate,
} from '../../src/lifecycle/index.js'
import { loadManifest } from '../../src/manifest.js'
import { tenantModuleDbName } from '../../src/names.js'
import { pinnedPhaseFor } from '../../src/phase.js'
import { PINNED_BASELINE } from '../../src/phase-baseline.js'
import { runMigrations } from '../../src/runner.js'
import { connectModule } from '../harness/db.js'
import { databasesOn, lcfixModule, lifecycleDeps, moduleServer, OPERATOR, platformDb, resetModuleServer, seedCatalogue, uuidv7 } from '../harness/lifecycle.js'

const TIP = '1'.repeat(40)
const OTHER_TIP = '2'.repeat(40)
const OP = OPERATOR.id
const EVIDENCE = (m: string) => `sha256:${'d'.repeat(64)} scripts/verify/out/isolation/${TIP}.json#${m}`

async function sqlError(p: Promise<unknown>): Promise<{ code?: string; constraint_name?: string } | undefined> {
  try {
    await p
  } catch (err) {
    return err as { code?: string; constraint_name?: string }
  }
  return undefined
}

async function refusal(p: Promise<unknown>): Promise<EnableRefused> {
  try {
    await p
  } catch (err) {
    if (err instanceof EnableRefused) return err
    throw err
  }
  throw new Error('expected an EnableRefused, the call succeeded')
}

async function result(platform: Sql, moduleKey: string, o: { passed?: boolean; tip?: string; runAt?: Date; evidence?: string; kind?: string } = {}): Promise<string> {
  const [r] = await platform<{ id: string }[]>`
    INSERT INTO plt.isolation_test_result (module_id, test_kind, passed, run_at, evidence_ref, release_tip_sha)
    SELECT module_id, ${o.kind ?? 'cross_customer'}, ${o.passed ?? true}, ${o.runAt ?? new Date()}, ${o.evidence ?? EVIDENCE(moduleKey)}, ${o.tip ?? TIP}
      FROM plt.module WHERE module_key = ${moduleKey}
    RETURNING isolation_test_result_id::text AS id`
  if (!r) throw new Error(`no module ${moduleKey}`)
  return r.id
}

const decision = (customerId: string, moduleKey: string, documentRef = 'TOM-Anhang 4.1') =>
  ({ customerId, moduleKey, requiresDpia: 'no' as const, reasonCodes: ['no_special_category'], documentRef, decidedBy: { kind: 'operator' as const, id: OP } })

async function moduleIds(platform: Sql, moduleKey: string): Promise<{ module_id: string; module_version_id: string }> {
  const [ids] = await platform<{ module_id: string; module_version_id: string }[]>`
    SELECT m.module_id::text, v.module_version_id::text FROM plt.module m JOIN plt.module_version v USING (module_id) WHERE m.module_key = ${moduleKey}`
  return ids!
}

describe('TDD 1: the platform schema 0006-0008 (SCHEMA verbatim, keys NOT VALID)', () => {
  let platform: Sql
  beforeAll(async () => {
    platform = platformDb()
    for (const m of ['schema_a', 'schema_b']) await seedCatalogue(platform, m)
  })
  afterAll(async () => {
    await platform`DELETE FROM plt.module_enablement WHERE module_id IN (SELECT module_id FROM plt.module WHERE module_key IN ('schema_a', 'schema_b'))`
    await platform.unsafe('DROP SCHEMA IF EXISTS t044_probe CASCADE')
    await platform.end()
  })

  it('ops holds touch_row, refuse_update and freeze_terminal; freeze_terminal refuses an UPDATE once the column is set (or holds a listed value)', async () => {
    const fns = await platform<{ f: string }[]>`
      SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'ops' ORDER BY 1`
    expect(fns.map((x) => x.f)).toEqual(expect.arrayContaining(['freeze_terminal', 'refuse_update', 'touch_row']))
    await platform.unsafe(`
      DROP SCHEMA IF EXISTS t044_probe CASCADE;
      CREATE SCHEMA t044_probe;
      CREATE TABLE t044_probe.job (id int PRIMARY KEY, closed_at timestamptz, state text, note text);
      CREATE TRIGGER job_freeze_trg BEFORE UPDATE ON t044_probe.job FOR EACH ROW EXECUTE FUNCTION ops.freeze_terminal('closed_at');
      CREATE TABLE t044_probe.req (id int PRIMARY KEY, state text, note text);
      CREATE TRIGGER req_freeze_trg BEFORE UPDATE ON t044_probe.req FOR EACH ROW EXECUTE FUNCTION ops.freeze_terminal('state', 'done', 'failed');
      INSERT INTO t044_probe.job VALUES (1, NULL, 'open', 'a');
      INSERT INTO t044_probe.req VALUES (1, 'open', 'a');`)
    await platform.unsafe(`UPDATE t044_probe.job SET closed_at = now() WHERE id = 1`)
    expect(await sqlError(platform.unsafe(`UPDATE t044_probe.job SET note = 'b' WHERE id = 1`))).toMatchObject({ code: '23514' })
    await platform.unsafe(`UPDATE t044_probe.req SET note = 'b' WHERE id = 1`)
    await platform.unsafe(`UPDATE t044_probe.req SET state = 'done' WHERE id = 1`)
    expect(await sqlError(platform.unsafe(`UPDATE t044_probe.req SET note = 'c' WHERE id = 1`))).toMatchObject({ code: '23514' })
  })

  it('plt.isolation_test_result: v7 ids, two kinds, a full commit id, evidence 1-500, append-only', async () => {
    const [{ module_id: m }] = [await moduleIds(platform, 'schema_a')]
    const ins = (o: { id?: string; kind?: string; tip?: string; ev?: string }) => platform`
      INSERT INTO plt.isolation_test_result (isolation_test_result_id, module_id, test_kind, passed, run_at, evidence_ref, release_tip_sha)
      VALUES (${o.id ?? uuidv7()}, ${m}, ${o.kind ?? 'cross_customer'}, true, now(), ${o.ev ?? 'sha256:x y'}, ${o.tip ?? TIP})`
    expect(await sqlError(ins({ id: '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e' }))).toMatchObject({ code: '23514', constraint_name: 'isolation_test_result_isolation_test_result_id_check' })
    expect(await sqlError(ins({ kind: 'cross_tenant' }))).toMatchObject({ code: '23514', constraint_name: 'isolation_test_result_test_kind_check' })
    expect(await sqlError(ins({ tip: 'HEAD' }))).toMatchObject({ code: '23514', constraint_name: 'isolation_test_result_release_tip_sha_check' })
    expect(await sqlError(ins({ tip: 'A'.repeat(40) }))).toMatchObject({ code: '23514', constraint_name: 'isolation_test_result_release_tip_sha_check' })
    expect(await sqlError(ins({ ev: '' }))).toMatchObject({ code: '23514', constraint_name: 'isolation_test_result_evidence_ref_check' })
    await ins({ tip: 'f'.repeat(64) })
    const id = await result(platform, 'schema_a')
    expect(await sqlError(platform`UPDATE plt.isolation_test_result SET passed = false WHERE isolation_test_result_id = ${id}`)).toMatchObject({ code: '23514' })
  })

  it('ops.dpia_decision: `yes` without a document is 23514; an unknown value or a bad reason code is 23514; append-only', async () => {
    const { module_id: m } = await moduleIds(platform, 'schema_a')
    const C = uuidv7()
    const ins = (o: { req?: string; codes?: string[]; doc?: string | null; kind?: string }) => platform`
      INSERT INTO ops.dpia_decision (customer_id, module_id, requires_dpia, reason_codes, document_ref, decided_by_kind, decided_by)
      VALUES (${C}, ${m}, ${o.req ?? 'no'}, ${o.codes ?? ['none']}, ${o.doc === undefined ? 'TOM 1' : o.doc}, ${o.kind ?? 'operator'}, ${OP})`
    expect(await sqlError(ins({ req: 'yes', doc: null }))).toMatchObject({ code: '23514', constraint_name: 'dpia_decision_document_required_check' })
    expect(await sqlError(ins({ req: 'maybe' }))).toMatchObject({ code: '23514', constraint_name: 'dpia_decision_requires_dpia_check' })
    expect(await sqlError(ins({ codes: ['Bad-Code'] }))).toMatchObject({ code: '23514', constraint_name: 'dpia_decision_reason_codes_check' })
    expect(await sqlError(ins({ codes: [] }))).toMatchObject({ code: '23514', constraint_name: 'dpia_decision_reason_codes_check' })
    expect(await sqlError(ins({ kind: 'system' }))).toMatchObject({ code: '23514', constraint_name: 'dpia_decision_decided_by_kind_check' })
    await ins({ req: 'no', doc: null }) // the TABLE allows a 'no' without a document; the gate does not (Q3)
    expect(await sqlError(platform`UPDATE ops.dpia_decision SET document_ref = 'x' WHERE customer_id = ${C}`)).toMatchObject({ code: '23514' })
  })

  it('DB backstop (TRD-063): enabling with a failed, another module\'s or an unknown result is 23503; null references 23514; the own pass is accepted', async () => {
    const a = await moduleIds(platform, 'schema_a')
    const X = uuidv7()
    await platform`
      INSERT INTO plt.module_enablement (customer_id, module_id, module_version_id, created_by_kind, updated_by_kind)
      VALUES (${X}, ${a.module_id}, ${a.module_version_id}, 'system', 'system')`
    const enable = (iso: string | null, dpia: string | null) => platform`
      UPDATE plt.module_enablement SET state = 'enabled', isolation_test_result_id = ${iso}, dpia_decision_id = ${dpia},
             enabled_by_kind = 'operator', enabled_by = ${OP}, enabled_at = now()
       WHERE customer_id = ${X} AND module_id = ${a.module_id}`
    const failed = await result(platform, 'schema_a', { passed: false })
    const foreign = await result(platform, 'schema_b')
    const KEY = 'module_enablement_isol_result_id_module_id_kind_passed_fkey'
    expect(await sqlError(enable(failed, uuidv7()))).toMatchObject({ code: '23503', constraint_name: KEY })
    expect(await sqlError(enable(foreign, uuidv7()))).toMatchObject({ code: '23503', constraint_name: KEY })
    expect(await sqlError(enable(uuidv7(), uuidv7()))).toMatchObject({ code: '23503', constraint_name: KEY })
    expect(await sqlError(enable(null, null))).toMatchObject({ code: '23514', constraint_name: 'module_enablement_gate_check' })
    const crossBody = await result(platform, 'schema_a', { kind: 'cross_body' })
    expect(await sqlError(enable(crossBody, uuidv7()))).toMatchObject({ code: '23503', constraint_name: KEY })
    const own = await result(platform, 'schema_a')
    await enable(own, uuidv7()) // dpia_decision_id is an xref (no key, SCHEMA :1776)
    const [row] = await platform<{ enabled: boolean }[]>`SELECT enabled FROM plt.module_enablement WHERE customer_id = ${X}`
    expect(row?.enabled).toBe(true)
    // the cross-body key: only a passing cross_body result of the module
    expect(await sqlError(platform`UPDATE plt.module_enablement SET cross_body_test_result_id = ${own} WHERE customer_id = ${X}`)).toMatchObject({
      code: '23503',
      constraint_name: 'module_enablement_xbody_result_id_module_id_kind_passed_fkey',
    })
    await platform`UPDATE plt.module_enablement SET cross_body_test_result_id = ${crossBody} WHERE customer_id = ${X}`
    // module_version's key, validated in 0007
    expect(await sqlError(platform`UPDATE plt.module_version SET isolation_test_result_id = ${failed} WHERE module_version_id = ${a.module_version_id}`)).toMatchObject({
      code: '23503',
      constraint_name: 'module_version_isol_result_id_module_id_kind_passed_fkey',
    })
    const keys = await platform<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%_kind_passed_fkey' ORDER BY 1`
    expect(keys).toEqual([
      { conname: 'module_enablement_isol_result_id_module_id_kind_passed_fkey', convalidated: false },
      { conname: 'module_enablement_xbody_result_id_module_id_kind_passed_fkey', convalidated: false },
      { conname: 'module_version_isol_result_id_module_id_kind_passed_fkey', convalidated: true },
    ])
  })
})

describe('TDD 2 (lane note A4): what the interim gate let through, the real gate refuses', () => {
  let platform: Sql
  let server: ReturnType<typeof moduleServer>
  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    await seedCatalogue(platform, 'lcfix')
    await resetModuleServer(server.admin, platform)
  })
  afterAll(async () => {
    await resetModuleServer(server.admin, platform)
    await server.close()
    await platform.end()
  })

  /** TASK-043's operatorAllowGate answered with whatever id it held, for both references. */
  const interimShape = (iso: string, dpia: string): EnableGate => () => ({ isolationTestResultId: iso, dpiaDecisionId: dpia })

  it('(i) a real PASS recorded for ANOTHER release tip: the interim shape enables; createEnableGate refuses ISOLATION_STALE_TIP, no database, not enabled', async () => {
    const stale = await result(platform, 'lcfix', { tip: OTHER_TIP })
    const W = uuidv7()
    await enableModule(W, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { enableGate: interimShape(stale, uuidv7()) }))
    const [was] = await platform<{ state: string }[]>`SELECT e.state FROM plt.module_enablement e JOIN plt.module m USING (module_id) WHERE e.customer_id = ${W} AND m.module_key = 'lcfix'`
    expect(was?.state).toBe('enabled') // the gap: the FK proves a pass, never that it is this release's

    const X = uuidv7()
    await recordDpiaDecision(platform, decision(X, 'lcfix'))
    const before = await databasesOn(server.admin)
    const err = await refusal(enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { enableGate: createEnableGate({ platform, releaseTipSha: TIP }) })))
    expect(err).toMatchObject({ code: 'ISOLATION_STALE_TIP', moduleKey: 'lcfix', customerId: X, tipSha: TIP })
    expect(err.reason).toContain(OTHER_TIP)
    expect(await databasesOn(server.admin)).toEqual(before)
    expect(await databasesOn(server.admin)).not.toContain(tenantModuleDbName(X, 'lcfix'))
    expect(await platform`SELECT 1 FROM plt.module_enablement WHERE customer_id = ${X} AND state = 'enabled'`).toHaveLength(0)
    expect(await platform`SELECT 1 FROM plt.module_database WHERE customer_id = ${X}`).toHaveLength(0)
  })

  it('(ii) a UUIDv7 with no ops.dpia_decision row: the interim shape enables; createEnableGate refuses NO_DPIA_DECISION, no database, not enabled', async () => {
    const pass = await result(platform, 'lcfix', { tip: TIP })
    const W = uuidv7()
    const dangling = uuidv7()
    await enableModule(W, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { enableGate: interimShape(pass, dangling) }))
    const [was] = await platform<{ dpia: string }[]>`SELECT dpia_decision_id::text AS dpia FROM plt.module_enablement WHERE customer_id = ${W} AND state = 'enabled'`
    expect(was?.dpia).toBe(dangling) // the gap: dpia_decision_id is an xref, nothing checks it

    const X = uuidv7()
    const before = await databasesOn(server.admin)
    const err = await refusal(enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { enableGate: createEnableGate({ platform, releaseTipSha: TIP }) })))
    expect(err).toMatchObject({ code: 'NO_DPIA_DECISION', moduleKey: 'lcfix', customerId: X })
    expect(err.message).toMatch(/^NO_DPIA_DECISION: module lcfix for customer /)
    expect(await databasesOn(server.admin)).toEqual(before)
    expect(await platform`SELECT 1 FROM plt.module_enablement WHERE customer_id = ${X} AND state = 'enabled'`).toHaveLength(0)
  })

  it('with a current-tip pass and a written decision, createEnableGate enables and the row carries the gate\'s two references', async () => {
    const pass = await result(platform, 'lcfix', { tip: TIP })
    const X = uuidv7()
    const { dpiaDecisionId } = await recordDpiaDecision(platform, decision(X, 'lcfix'))
    const r = await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { enableGate: createEnableGate({ platform, releaseTipSha: TIP }) }))
    expect(r).toMatchObject({ database: tenantModuleDbName(X, 'lcfix'), created: true, noop: false })
    const [row] = await platform<{ iso: string; dpia: string; xb: string | null }[]>`
      SELECT isolation_test_result_id::text AS iso, dpia_decision_id::text AS dpia, cross_body_test_result_id::text AS xb
        FROM plt.module_enablement WHERE customer_id = ${X} AND state = 'enabled'`
    expect(row).toEqual({ iso: pass, dpia: dpiaDecisionId, xb: null })
  })
})

describe('TDD 3: every gate code over real rows', () => {
  let platform: Sql
  const C = uuidv7()
  const D = uuidv7()
  beforeAll(async () => {
    platform = platformDb()
    for (const m of ['gate_none', 'gate_fail', 'gate_back', 'gate_stale', 'gate_fix', 'gate_dpia', 'gate_ok']) await seedCatalogue(platform, m)
  })
  afterAll(async () => {
    await platform.end()
  })
  const gate = (o: { tip?: string | null; fixtures?: boolean } = {}) =>
    createEnableGate({ platform, releaseTipSha: o.tip === undefined ? TIP : o.tip, ...(o.fixtures ? { allowFixtureEvidence: true } : {}) })
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)

  it('NO_ISOLATION_RESULT: nothing recorded for the module (a cross_body result does not count)', async () => {
    await result(platform, 'gate_none', { kind: 'cross_body' })
    await recordDpiaDecision(platform, decision(C, 'gate_none'))
    expect(await refusal(Promise.resolve(gate()(C, 'gate_none')))).toMatchObject({ code: 'NO_ISOLATION_RESULT', moduleKey: 'gate_none', customerId: C, tipSha: TIP })
  })

  it('ISOLATION_FAILED: a newer fail beats an older pass; a newer pass beats an older fail', async () => {
    await result(platform, 'gate_fail', { passed: true, runAt: t(10) })
    const failed = await result(platform, 'gate_fail', { passed: false, runAt: t(5) })
    await recordDpiaDecision(platform, decision(C, 'gate_fail'))
    const err = await refusal(Promise.resolve(gate()(C, 'gate_fail')))
    expect(err.code).toBe('ISOLATION_FAILED')
    expect(err.reason).toContain(failed)
    await result(platform, 'gate_back', { passed: false, runAt: t(10) })
    const pass = await result(platform, 'gate_back', { passed: true, runAt: t(5) })
    await recordDpiaDecision(platform, decision(C, 'gate_back'))
    expect((await gate()(C, 'gate_back'))?.isolationTestResultId).toBe(pass)
  })

  it('ISOLATION_STALE_TIP: the latest pass names another tip, even with an older pass on this tip', async () => {
    await result(platform, 'gate_stale', { tip: TIP, runAt: t(10) })
    await result(platform, 'gate_stale', { tip: OTHER_TIP, runAt: t(5) })
    await recordDpiaDecision(platform, decision(C, 'gate_stale'))
    const err = await refusal(Promise.resolve(gate()(C, 'gate_stale')))
    expect(err.code).toBe('ISOLATION_STALE_TIP')
    expect(err.reason).toContain(OTHER_TIP)
    expect(err.reason).toContain(TIP)
  })

  it('FIXTURE_EVIDENCE (Q6): scratch-fixture evidence is refused unless the gate is built for a scratch stack', async () => {
    const fx = await result(platform, 'gate_fix', { evidence: 'scratch-fixture:t044 calendar' })
    await recordDpiaDecision(platform, decision(C, 'gate_fix'))
    expect(await refusal(Promise.resolve(gate()(C, 'gate_fix')))).toMatchObject({ code: 'FIXTURE_EVIDENCE' })
    expect((await gate({ fixtures: true })(C, 'gate_fix'))?.isolationTestResultId).toBe(fx)
  })

  it('NO_DPIA_DECISION: none; only another customer\'s; the latest one without document_ref (any requires_dpia, Q3)', async () => {
    await result(platform, 'gate_dpia')
    expect(await refusal(Promise.resolve(gate()(C, 'gate_dpia')))).toMatchObject({ code: 'NO_DPIA_DECISION' })
    await recordDpiaDecision(platform, decision(D, 'gate_dpia'))
    expect(await refusal(Promise.resolve(gate()(C, 'gate_dpia')))).toMatchObject({ code: 'NO_DPIA_DECISION', customerId: C })
    expect((await gate()(D, 'gate_dpia'))?.dpiaDecisionId).toBeTruthy()
    const { module_id } = await moduleIds(platform, 'gate_dpia')
    await recordDpiaDecision(platform, decision(C, 'gate_dpia'))
    // a later decision with no document (the table allows `no`/`not_applicable` without one): the latest wins
    for (const req of ['no', 'not_applicable']) {
      await platform`
        INSERT INTO ops.dpia_decision (customer_id, module_id, requires_dpia, reason_codes, document_ref, decided_by_kind, decided_by, decided_at)
        VALUES (${C}, ${module_id}, ${req}, ${['undocumented']}, NULL, 'operator', ${OP}, now() + interval '1 second')`
      const err = await refusal(Promise.resolve(gate()(C, 'gate_dpia')))
      expect(err.code).toBe('NO_DPIA_DECISION')
      expect(err.reason).toMatch(/document_ref/)
    }
  })

  it('NO_RELEASE_TIP first: an unset tip refuses even a fully proven module', async () => {
    await result(platform, 'gate_ok')
    await recordDpiaDecision(platform, decision(C, 'gate_ok'))
    expect(await refusal(Promise.resolve(gate({ tip: null })(C, 'gate_ok')))).toMatchObject({ code: 'NO_RELEASE_TIP' })
  })

  it('the happy path returns both ids and no cross-body reference', async () => {
    const pass = await result(platform, 'gate_ok', { runAt: new Date(Date.now() + 1000) })
    const { dpiaDecisionId } = await recordDpiaDecision(platform, decision(C, 'gate_ok', 'TOM-Anhang 9'))
    expect(await gate()(C, 'gate_ok')).toEqual({ isolationTestResultId: pass, dpiaDecisionId, crossBodyTestResultId: null })
  })
})

describe('TDD 5: recordIsolationResults (verify evidence) and recordDpiaDecision', () => {
  let platform: Sql
  beforeAll(async () => {
    platform = platformDb()
    for (const m of ['rec_a', 'rec_b', 'rec_c']) await seedCatalogue(platform, m)
  })
  afterAll(async () => {
    await platform.end()
  })
  const evidence = (modules: string[], tip = TIP) => ({
    produced_by: 'verify',
    tree_clean: true,
    release_tip_sha: tip,
    verify_record: { suite: 'isolation:tenant', sha: tip, startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:03:00.000Z', collected: 4 * modules.length, passed: 4 * modules.length, failed: 0 },
    results: modules.map((m) => ({ module: m, test_kind: 'cross_customer', passed: true, run_at: '2026-10-05T10:02:00.000Z', release_tip_sha: tip, evidence_ref: EVIDENCE(m) })),
  })
  const rows = async (m: string) =>
    platform<{ id: string; tip: string; ev: string; passed: boolean }[]>`
      SELECT r.isolation_test_result_id::text AS id, r.release_tip_sha AS tip, r.evidence_ref AS ev, r.passed
        FROM plt.isolation_test_result r JOIN plt.module m USING (module_id) WHERE m.module_key = ${m}`

  it('a stamped PASS round-trips; a second import of the same file writes nothing', async () => {
    const first = await recordIsolationResults(platform, evidence(['rec_a']))
    expect(first.inserted.map((r) => r.module)).toEqual(['rec_a'])
    expect(await rows('rec_a')).toEqual([{ id: first.inserted[0]!.isolationTestResultId, tip: TIP, ev: EVIDENCE('rec_a'), passed: true }])
    const again = await recordIsolationResults(platform, evidence(['rec_a']))
    expect(again).toEqual({ inserted: [], existing: [{ module: 'rec_a', testKind: 'cross_customer', isolationTestResultId: first.inserted[0]!.isolationTestResultId }] })
    expect(await rows('rec_a')).toHaveLength(1)
    // the imported pass is what the gate accepts
    const C = uuidv7()
    await recordDpiaDecision(platform, decision(C, 'rec_a'))
    expect((await createEnableGate({ platform, releaseTipSha: TIP })(C, 'rec_a'))?.isolationTestResultId).toBe(first.inserted[0]!.isolationTestResultId)
  })

  it('an unknown module refuses the whole file: nothing recorded, not even the known module', async () => {
    let caught: unknown
    try {
      await recordIsolationResults(platform, evidence(['rec_b', 'no_such_module']))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(IsolationEvidenceError)
    expect(caught).toMatchObject({ code: 'MODULE_UNKNOWN' })
    expect(await rows('rec_b')).toHaveLength(0)
  })

  it('an unstamped file is refused before the database', async () => {
    const ev = { ...evidence(['rec_b']), produced_by: 'run.mjs' }
    await expect(recordIsolationResults(platform, ev)).rejects.toMatchObject({ code: 'EVIDENCE_UNSTAMPED' })
    expect(await rows('rec_b')).toHaveLength(0)
  })

  it('two concurrent imports of the same evidence give one row', async () => {
    const other = platformDb()
    try {
      const [a, b] = await Promise.all([recordIsolationResults(platform, evidence(['rec_c'])), recordIsolationResults(other, evidence(['rec_c']))])
      expect(a.inserted.length + b.inserted.length).toBe(1)
      expect(a.existing.length + b.existing.length).toBe(1)
      expect(await rows('rec_c')).toHaveLength(1)
    } finally {
      await other.end()
    }
  })

  it('recordDpiaDecision appends; reuseIdentical returns the latest equal decision; an unknown module is MODULE_UNKNOWN', async () => {
    const C = uuidv7()
    const a = await recordDpiaDecision(platform, decision(C, 'rec_a'))
    expect(a.created).toBe(true)
    expect(await recordDpiaDecision(platform, decision(C, 'rec_a'), { reuseIdentical: true })).toEqual({ dpiaDecisionId: a.dpiaDecisionId, created: false })
    const b = await recordDpiaDecision(platform, decision(C, 'rec_a', 'TOM-Anhang 4.2'), { reuseIdentical: true })
    expect(b.created).toBe(true)
    expect(b.dpiaDecisionId).not.toBe(a.dpiaDecisionId)
    await expect(recordDpiaDecision(platform, decision(C, 'no_such_module'))).rejects.toMatchObject({ code: 'MODULE_UNKNOWN' })
    await expect(recordDpiaDecision(platform, { ...decision(C, 'rec_a'), documentRef: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

// A3 (G10): a catalogue migrated to 0004 that holds a TASK-043 interim
// enablement (both references = its attestation id), then migrated on. Built
// on the module server `pgm` (which has no gremion_platform of its own), like
// lifecycle-platform.test.ts, and dropped afterwards.
describe('TDD 9 + lane note A3: an attested enablement survives the migration, is named, re-gated, and the keys validate', () => {
  const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
  const PARTIAL = join(REPO, '.scratch', `t044-platform-0004-${process.pid}`)
  let admin: Sql
  let platform: Sql

  beforeAll(async () => {
    admin = connectModule('postgres', { max: 1 })
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DATABASE} WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE ${PLATFORM_DATABASE}`)
    platform = connectModule(PLATFORM_DATABASE, { max: 2 })
    // the catalogue as TASK-043 left it: 0001-0004 only
    rmSync(PARTIAL, { recursive: true, force: true })
    mkdirSync(PARTIAL, { recursive: true })
    const manifest = loadManifest(PLATFORM_MIGRATIONS_DIR)
    const upTo4: Record<string, string> = {}
    for (const [f, sha] of [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (f > '0004_~') continue
      cpSync(join(PLATFORM_MIGRATIONS_DIR, f), join(PARTIAL, f))
      upTo4[f] = sha
    }
    writeFileSync(join(PARTIAL, 'manifest.json'), `${JSON.stringify(upTo4, null, 2)}\n`)
    await runMigrations({ sql: platform, dir: PARTIAL, releaseRef: 'dist-v0.0.1', phaseFor: pinnedPhaseFor('platform', PINNED_BASELINE), log: () => {} })
  })

  afterAll(async () => {
    await platform.end()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DATABASE} WITH (FORCE)`)
    await admin.end()
    rmSync(PARTIAL, { recursive: true, force: true })
  })

  it('(a) the migration applies over the interim row with the keys NOT VALID; (b) unprovenEnablements and attestedEnablements name it; (c) the re-gate writes the real references and the keys VALIDATE', async () => {
    expect((await platform<{ f: string }[]>`SELECT filename AS f FROM public.schema_migrations ORDER BY 1`).map((r) => r.f)).toEqual([
      '0001_plt_setup.sql',
      '0002_plt_module.sql',
      '0003_plt_module_database.sql',
      '0004_plt_provisioning_step.sql',
    ])
    await seedCatalogue(platform, 'calendar')
    const ids = await moduleIds(platform, 'calendar')
    const X = uuidv7()
    const [att] = await platform<{ id: string }[]>`
      INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
      VALUES (${X}, 'calendar', ${OP}, ${['calendar']}, 'interim gate, no isolation test (TASK-044)') RETURNING attestation_id::text AS id`
    await platform`
      INSERT INTO plt.module_enablement (customer_id, module_id, module_version_id, state, isolation_test_result_id, dpia_decision_id,
        enabled_by_kind, enabled_by, enabled_at, created_by_kind, created_by, updated_by_kind, updated_by)
      VALUES (${X}, ${ids.module_id}, ${ids.module_version_id}, 'enabled', ${att!.id}, ${att!.id}, 'operator', ${OP}, now(), 'operator', ${OP}, 'operator', ${OP})`

    // (a)
    const m = await migratePlatform(platform, { releaseRef: 'dist-v0.0.2', log: () => {} })
    expect(m.applied).toEqual(expect.arrayContaining(['0006_ops_setup.sql', '0007_plt_isolation_test_result.sql', '0008_ops_dpia_decision.sql']))
    const [kept] = await platform<{ iso: string; state: string }[]>`SELECT isolation_test_result_id::text AS iso, state FROM plt.module_enablement WHERE customer_id = ${X}`
    expect(kept).toEqual({ iso: att!.id, state: 'enabled' })

    // (b)
    const unproven = await unprovenEnablements({ platform, releaseTipSha: TIP })
    expect(unproven).toHaveLength(1)
    expect(unproven[0]).toMatchObject({ customerId: X, moduleKey: 'calendar', isolationTestResultId: att!.id, dpiaDecisionId: att!.id })
    expect(unproven[0]!.codes).toEqual(expect.arrayContaining(['NO_ISOLATION_RESULT', 'NO_DPIA_DECISION']))
    expect(await attestedEnablements(platform)).toEqual([{ customerId: X, moduleKey: 'calendar', attestationId: att!.id, state: 'enabled', enabledAt: expect.any(Date) }])
    expect(await validateGateForeignKeys(platform)).toEqual({
      validated: ['module_enablement_xbody_result_id_module_id_kind_passed_fkey'],
      alreadyValid: [],
      pending: [{ name: 'module_enablement_isol_result_id_module_id_kind_passed_fkey', violators: 1 }],
    })
    // the gate refuses the re-gate until the records exist; the row is untouched
    expect(await refusal(regateEnablement({ platform, releaseTipSha: TIP, customerId: X, moduleKey: 'calendar', actor: OPERATOR }))).toMatchObject({ code: 'NO_ISOLATION_RESULT' })

    // (c)
    const pass = await result(platform, 'calendar', { tip: TIP })
    const { dpiaDecisionId } = await recordDpiaDecision(platform, decision(X, 'calendar'))
    const r = await regateEnablement({ platform, releaseTipSha: TIP, customerId: X, moduleKey: 'calendar', actor: OPERATOR })
    expect(r).toEqual({ customerId: X, moduleKey: 'calendar', before: { isolationTestResultId: att!.id, dpiaDecisionId: att!.id }, after: { isolationTestResultId: pass, dpiaDecisionId }, updated: true })
    expect((await regateEnablement({ platform, releaseTipSha: TIP, customerId: X, moduleKey: 'calendar', actor: OPERATOR })).updated).toBe(false)
    expect(await unprovenEnablements({ platform, releaseTipSha: TIP })).toEqual([])
    expect(await validateGateForeignKeys(platform)).toEqual({
      validated: ['module_enablement_isol_result_id_module_id_kind_passed_fkey'],
      alreadyValid: ['module_enablement_xbody_result_id_module_id_kind_passed_fkey'],
      pending: [],
    })
    const keys = await platform<{ convalidated: boolean }[]>`SELECT convalidated FROM pg_constraint WHERE conname LIKE '%_kind_passed_fkey'`
    expect(keys.map((k) => k.convalidated)).toEqual([true, true, true])
    // a new tip makes the enabled module unproven again (Q8): its pass is the old release's
    const later = await unprovenEnablements({ platform, releaseTipSha: OTHER_TIP })
    expect(later.map((u) => [u.moduleKey, u.codes])).toEqual([['calendar', ['ISOLATION_STALE_TIP']]])
  })
})
