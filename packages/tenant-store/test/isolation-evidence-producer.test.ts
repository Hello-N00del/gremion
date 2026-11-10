// Pilot wave 2, Task 1: the file the isolation evidence PRODUCER writes
// (scripts/verify/lib/isolation-evidence.mjs, fed by suites/isolation-tenant.mjs)
// is the file the module enable gate consumes
// (src/lifecycle/enable-gate/{record,gate}.ts). Here the two meet:
//   - a passing producer run parses with parseIsolationEvidence;
//   - recordIsolationResults inserts one row per module against the integration
//     database, and assertIsolationProven then resolves on that tip and throws
//     ISOLATION_STALE_TIP on another;
//   - a tampered copy (counts changed, tip changed, a `passed: false` entry, a
//     changed stamp, a malformed reference) is refused with the parser's codes,
//     and nothing reaches the database.
// The producer is an .mjs outside this package; it is loaded by URL, so the
// package's typecheck does not reach into scripts/.
//
// Runs under vitest.integration.config.ts (the scratch stack, test/harness).
// The rows this file writes carry a tip of its own and are removed again at the
// end: lifecycle-enable-gate.test.ts shares gremion_platform and asserts the
// absence of a result for `calendar`.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertIsolationProven, EnableRefused, IsolationEvidenceError, parseIsolationEvidence, recordIsolationResults } from '../src/lifecycle/index.js'
import { platformDb, seedCatalogue } from './harness/lifecycle.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const load = (rel: string) => import(pathToFileURL(join(REPO, rel)).href)

interface Part {
  label: string
  toolMissing: null
  unparseable: false
  collected: number
  passed: number
  failed: number
  skipped: number
  skipsByFile: Record<string, number>
  collectedFiles: string[]
  detail: string
  reportFile: string
}
interface Case {
  module: string
  files: string[]
}
const suiteMod = (await load('scripts/verify/suites/isolation-tenant.mjs')) as {
  ISOLATION_TENANT_PART: string
  ISOLATION_TENANT_MODULES: string[]
  isolationTenantCases(): Case[]
  runIsolationTenantSuite(o: Record<string, unknown>): Record<string, unknown>
}
const evidenceMod = (await load('scripts/verify/lib/isolation-evidence.mjs')) as {
  writeIsolationEvidence(o: Record<string, unknown>): { path: string; evidence: unknown }
}
const verifyMod = (await load('scripts/verify/verify.mjs')) as {
  runAll(names: string[], o: Record<string, unknown>): Record<string, Record<string, unknown>>
}

const MODULES = [...suiteMod.ISOLATION_TENANT_MODULES]
const scratch: string[] = []
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  scratch.push(d)
  return d
}
const hex40 = () => randomBytes(20).toString('hex')

/** What `verify --only isolation:tenant` writes for a passing run on `tip`: the real suite and writer, a fake vitest. */
function producePassingEvidence(tip: string): { file: string; json: Record<string, any> } {
  const cases = suiteMod.isolationTenantCases()
  const runVitest = (o: { label: string; keepReportAt: string }): Part => {
    const module = o.keepReportAt.split(/[\\/]/).pop()!.replace('.vitest.json', '')
    writeFileSync(o.keepReportAt, JSON.stringify({ module, producer: 'tenant-store test', numTotalTests: 4 }))
    return {
      label: o.label,
      toolMissing: null,
      unparseable: false,
      collected: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
      skipsByFile: {},
      collectedFiles: cases.find((c) => c.module === module)!.files,
      detail: '',
      reportFile: o.keepReportAt,
    }
  }
  const raw = suiteMod.runIsolationTenantSuite({
    root: REPO,
    cases,
    env: { ISOLATION_TENANT_PG_URL: 'postgres://postgres@127.0.0.1:55432/postgres' },
    runVitest,
    prepare: () => ({ ok: true, detail: '' }),
    tmpRoot: tmp('iso-producer-suite-'),
  })
  const part = suiteMod.ISOLATION_TENANT_PART
  const result = verifyMod.runAll([part], { skipsData: { entries: [] }, registry: { [part]: () => raw } })[part]!
  expect(result.status).toBe('pass')
  const out = writeEvidenceTo(tip, result)
  return out
}

function writeEvidenceTo(tip: string, result: Record<string, unknown>): { file: string; json: Record<string, any> } {
  const outDir = tmp('iso-producer-out-')
  const { path, evidence } = evidenceMod.writeIsolationEvidence({
    sha: tip,
    names: [suiteMod.ISOLATION_TENANT_PART],
    result,
    startedAt: '2026-11-09T10:00:00.000Z',
    finishedAt: '2026-11-09T10:05:00.000Z',
    outDir,
  })
  return { file: path, json: JSON.parse(JSON.stringify(evidence)) }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

async function code(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof IsolationEvidenceError) return err.code
    throw err
  }
  return undefined
}

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

describe('the producer output is the parser input (no database)', () => {
  it('a passing producer run parses with parseIsolationEvidence: stamped by verify, one cross_customer result per declared module', () => {
    const tip = hex40()
    const { json } = producePassingEvidence(tip)
    const parsed = parseIsolationEvidence(json)
    expect(parsed.produced_by).toBe('verify')
    expect(parsed.tree_clean).toBe(true)
    expect(parsed.release_tip_sha).toBe(tip)
    expect(parsed.verify_record).toMatchObject({ suite: 'isolation:tenant', sha: tip, failed: 0 })
    expect(parsed.verify_record.passed).toBe(parsed.verify_record.collected)
    expect(parsed.results.map((r) => r.module).sort()).toEqual([...MODULES].sort())
    for (const r of parsed.results) {
      expect(r.test_kind).toBe('cross_customer')
      expect(r.release_tip_sha).toBe(tip)
      expect(r.evidence_ref.startsWith('scratch-fixture:')).toBe(false)
    }
    for (const banned of ['board', 'elections', 'finance', 'vault', 'handover']) {
      expect(parsed.results.some((r) => r.module === banned)).toBe(false)
    }
  })

  it('a tampered copy is refused with the parser codes: counts, tip, a passed:false entry, the stamp, the reference, an empty list', async () => {
    const { json } = producePassingEvidence(hex40())
    const counts = clone(json)
    counts.verify_record.collected = 0
    expect(await code(() => parseIsolationEvidence(counts))).toBe('EVIDENCE_NOT_PASS')

    const failedCount = clone(json)
    failedCount.verify_record.failed = 1
    expect(await code(() => parseIsolationEvidence(failedCount))).toBe('EVIDENCE_NOT_PASS')

    const skippedShape = clone(json)
    skippedShape.verify_record.passed = skippedShape.verify_record.collected - 1
    expect(await code(() => parseIsolationEvidence(skippedShape))).toBe('EVIDENCE_NOT_PASS')

    const tip = clone(json)
    tip.release_tip_sha = hex40()
    expect(await code(() => parseIsolationEvidence(tip))).toBe('EVIDENCE_NOT_PASS')

    const entryTip = clone(json)
    entryTip.results[0].release_tip_sha = hex40()
    expect(await code(() => parseIsolationEvidence(entryTip))).toBe('EVIDENCE_MALFORMED')

    const failedEntry = clone(json)
    failedEntry.results[0].passed = false
    expect(await code(() => parseIsolationEvidence(failedEntry))).toBe('EVIDENCE_NOT_PASS')

    const unstamped = clone(json)
    unstamped.produced_by = 'run.mjs'
    expect(await code(() => parseIsolationEvidence(unstamped))).toBe('EVIDENCE_UNSTAMPED')

    const dirty = clone(json)
    dirty.tree_clean = false
    expect(await code(() => parseIsolationEvidence(dirty))).toBe('EVIDENCE_UNSTAMPED')

    const wrongSuite = clone(json)
    wrongSuite.verify_record.suite = 'isolation'
    expect(await code(() => parseIsolationEvidence(wrongSuite))).toBe('EVIDENCE_NOT_PASS')

    const ref = clone(json)
    ref.results[0].evidence_ref = 'scratch-fixture:harness'
    expect(await code(() => parseIsolationEvidence(ref))).toBe('EVIDENCE_MALFORMED')

    const empty = clone(json)
    empty.results = []
    expect(await code(() => parseIsolationEvidence(empty))).toBe('EVIDENCE_EMPTY')
  })
})

describe('recorded against the integration database, read the way the gate reads it', () => {
  let platform: Sql
  const tip = hex40()
  const createdModules: string[] = []

  beforeAll(async () => {
    platform = platformDb()
    for (const m of MODULES) {
      const [have] = await platform<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.module WHERE module_key = ${m}`
      if (have!.n === 0) createdModules.push(m)
      await seedCatalogue(platform, m)
    }
  })

  afterAll(async () => {
    try {
      await platform`DELETE FROM plt.isolation_test_result WHERE release_tip_sha = ${tip}`
      for (const m of createdModules) {
        await platform`DELETE FROM plt.module_version WHERE module_id IN (SELECT module_id FROM plt.module WHERE module_key = ${m})`
        await platform`DELETE FROM plt.module WHERE module_key = ${m}`
      }
    } finally {
      await platform.end()
    }
  })

  it('inserts one row per module; a second import inserts nothing; assertIsolationProven resolves on the tip and refuses another as ISOLATION_STALE_TIP', async () => {
    const { json } = producePassingEvidence(tip)
    const r = await recordIsolationResults(platform, json)
    expect(r.inserted.map((x) => x.module).sort()).toEqual([...MODULES].sort())
    expect(r.existing).toEqual([])

    const rows = await platform<{ module_key: string; passed: boolean; release_tip_sha: string; evidence_ref: string; test_kind: string }[]>`
      SELECT m.module_key, r.passed, r.release_tip_sha, r.evidence_ref, r.test_kind
        FROM plt.isolation_test_result r JOIN plt.module m ON m.module_id = r.module_id
       WHERE r.release_tip_sha = ${tip} ORDER BY 1`
    expect(rows.map((x) => x.module_key)).toEqual([...MODULES].sort())
    for (const row of rows) {
      expect(row).toMatchObject({ passed: true, release_tip_sha: tip, test_kind: 'cross_customer' })
      expect(row.evidence_ref).toMatch(/^sha256:[0-9a-f]{64} \S/)
      expect(row.evidence_ref.startsWith('scratch-fixture:')).toBe(false)
    }

    const again = await recordIsolationResults(platform, json)
    expect(again.inserted).toEqual([])
    expect(again.existing).toHaveLength(MODULES.length)

    await expect(assertIsolationProven({ platform, releaseTipSha: tip }, MODULES)).resolves.toBeUndefined()
    const other = hex40()
    const err = await assertIsolationProven({ platform, releaseTipSha: other }, MODULES).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnableRefused)
    expect(err).toMatchObject({ code: 'ISOLATION_STALE_TIP' })
  })

  it('a module the catalogue does not know refuses the whole file: nothing is recorded', async () => {
    const otherTip = hex40()
    const { json } = producePassingEvidence(otherTip)
    const unknown = clone(json)
    unknown.results[0].module = 'not_in_catalogue'
    expect(await code(() => recordIsolationResults(platform, unknown))).toBe('MODULE_UNKNOWN')
    const [row] = await platform<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.isolation_test_result WHERE release_tip_sha = ${otherTip}`
    expect(row!.n).toBe(0)
  })

  it('a tampered copy never reaches the table', async () => {
    const tamperTip = hex40()
    const { json } = producePassingEvidence(tamperTip)
    const failedEntry = clone(json)
    failedEntry.results[1].passed = false
    expect(await code(() => recordIsolationResults(platform, failedEntry))).toBe('EVIDENCE_NOT_PASS')
    const counts = clone(json)
    counts.verify_record.collected = 0
    expect(await code(() => recordIsolationResults(platform, counts))).toBe('EVIDENCE_NOT_PASS')
    const [row] = await platform<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.isolation_test_result WHERE release_tip_sha = ${tamperTip}`
    expect(row!.n).toBe(0)
  })
})
