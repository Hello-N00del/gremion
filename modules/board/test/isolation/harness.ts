// modules/board/test/isolation/harness.ts
//
// A minimal two-tenant isolation runner whose rules are copied from TASK-044 §1
// (superseded by TASK-044's test/isolation/tenant/ harness once it exists):
//   - positive controls run FIRST on every run: B reads its own record (2xx +
//     canary); A seeds, reads (2xx + canary) and writes (2xx, fingerprint
//     changes) its own; then the case's own controls. A failed control fails
//     the run and no attempt is judged.
//   - zero attempts fails the run (vacuity).
//   - verdicts are the harness's, never the case's: a READ fails on any 2xx
//     that carries B's data or B's canary; a WRITE fails on any 2xx or on a
//     change in B's fingerprint, read back AS B.
import type { TenantRef } from '../../src/store/index.ts'
import type { ApiResult, BoardApi } from './api.ts'
import { is2xx, type Attempt, type AttemptContext, type IsolationCase } from './case.ts'

export interface ControlResult {
  name: string
  ok: boolean
  detail: string
}

export interface AttemptResult {
  vector: string
  route: string
  kind: 'read' | 'write'
  what: string
  status: number
  passed: boolean
  reason: string
}

export interface IsolationReport {
  ok: boolean
  /** Set when the run failed before or instead of judging attempts. */
  aborted?: string
  controls: ControlResult[]
  attempts: AttemptResult[]
}

/** One line per failed control or attempt, for an assertion message. */
export function describeFailures(r: IsolationReport): string {
  const lines: string[] = []
  if (r.aborted) lines.push(`ABORTED: ${r.aborted}`)
  for (const c of r.controls) if (!c.ok) lines.push(`control FAILED: ${c.name}: ${c.detail}`)
  for (const a of r.attempts) if (!a.passed) lines.push(`vector ${a.vector} ${a.route} (${a.what}) as A: ${a.reason}`)
  return lines.join('\n')
}

function carries(body: unknown, secrets: readonly string[]): string | null {
  const text = JSON.stringify(body) ?? ''
  return secrets.find((s) => text.includes(s)) ?? null
}

/**
 * Structural validation of a case against the leaf's route table, applied at
 * load (TRD-061): every route is covered by an attempt or a control, every
 * attempt and control names a route inside routePrefixes and in the table, and
 * a route that is a read has a read attempt and a route that writes has a
 * write attempt. `routes` maps each table route to what it does.
 */
export function validateCase<R>(c: IsolationCase<R>, routes: ReadonlyMap<string, 'read' | 'write' | 'control'>): string[] {
  const problems: string[] = []
  const prefixOk = (route: string) => {
    const path = route.split(' ')[1] ?? ''
    return c.routePrefixes.some((p) => path === p || path.startsWith(p + '/'))
  }
  if (c.attempts.length === 0) problems.push('the case has zero attempts')
  for (const a of c.attempts) {
    if (!routes.has(a.route)) problems.push(`attempt ${a.vector} names ${a.route}, which is not a leaf route`)
    if (!prefixOk(a.route)) problems.push(`attempt ${a.vector} ${a.route} is outside routePrefixes`)
  }
  for (const k of c.controls) {
    if (!routes.has(k.route)) problems.push(`control ${k.vector} names ${k.route}, which is not a leaf route`)
    if (!prefixOk(k.route)) problems.push(`control ${k.vector} ${k.route} is outside routePrefixes`)
  }
  for (const [route, kind] of routes) {
    const attempts = c.attempts.filter((a) => a.route === route)
    const controls = c.controls.filter((k) => k.route === route)
    if (kind === 'control') {
      if (controls.length === 0) problems.push(`${route} has no control`)
    } else if (!attempts.some((a) => a.kind === kind)) {
      problems.push(`${route} has no ${kind} attempt`)
    }
  }
  return problems
}

/**
 * Run a case. `routes` is the route table the case must cover (BOARD_ROUTE_KINDS
 * for the leaf): validateCase runs first, and a structurally incomplete case is
 * refused at load, before any seed, control or attempt (TRD-061).
 */
export async function runIsolation<R>(
  c: IsolationCase<R> & { attempts: readonly Attempt[] },
  opts: { api: BoardApi; attacker: TenantRef; victim: TenantRef; routes: ReadonlyMap<string, 'read' | 'write' | 'control'> },
): Promise<IsolationReport & { own?: R; victimRecord?: R }> {
  const { api, attacker, victim } = opts
  const controls: ControlResult[] = []
  const attempts: AttemptResult[] = []
  const problems = validateCase(c, opts.routes)
  if (problems.length > 0) return { ok: false, aborted: `case refused at load: ${problems.join('; ')}`, controls, attempts }
  const own = await c.seed(attacker)
  const vic = await c.seed(victim)
  const done = (extra: Partial<IsolationReport>) => ({
    ok: false,
    controls,
    attempts,
    own,
    victimRecord: vic,
    ...extra,
  })

  // ── positive controls, before any attempt ────────────────────────────────
  const control = (name: string, ok: boolean, detail: string) => controls.push({ name, ok, detail })
  const readOwn = async (who: string, as: TenantRef, rec: R) => {
    const r = await c.read(as, rec)
    const ok = is2xx(r) && (JSON.stringify(r.body) ?? '').includes(c.canary(rec))
    control(`${who} reads its own record`, ok, `${r.status}${ok ? ' + canary' : ` ${JSON.stringify(r.body).slice(0, 200)}`}`)
  }
  await readOwn('B', victim, vic)
  await readOwn('A', attacker, own)
  {
    const before = await c.fingerprint(attacker, own)
    const r = await c.write(attacker, own)
    const after = await c.fingerprint(attacker, own)
    control('A writes its own record', is2xx(r) && before !== after, `${r.status}, fingerprint ${before === after ? 'UNCHANGED' : 'changed'}`)
  }
  const ctx: AttemptContext = { api, attacker, own: own as never, victim: vic as never }
  for (const k of c.controls) {
    try {
      const out = await k.run({ ...ctx, fingerprint: (as, rec) => c.fingerprint(as, rec as unknown as R) })
      control(`vector ${k.vector} ${k.route}: ${k.what}`, out.ok, out.detail)
    } catch (err) {
      control(`vector ${k.vector} ${k.route}: ${k.what}`, false, `threw: ${(err as Error).message}`)
    }
  }
  if (controls.some((x) => !x.ok)) return done({ aborted: 'a positive control failed; no attempt was judged' })
  if (c.attempts.length === 0) return done({ aborted: 'zero attempts: the run is vacuous' })

  // ── attempts, harness-owned verdicts ─────────────────────────────────────
  const secrets = c.secrets(vic as unknown as R)
  for (const a of c.attempts) {
    let r: ApiResult
    let passed: boolean
    let reason: string
    if (a.kind === 'read') {
      r = await a.run(ctx)
      const leaked = is2xx(r) ? carries(r.body, secrets) : null
      passed = leaked === null
      reason = passed ? `${r.status}, no B data` : `${r.status} carries B's ${leaked === c.canary(vic) ? 'canary' : `id ${leaked}`}: ${JSON.stringify(r.body).slice(0, 300)}`
    } else {
      const before = await c.fingerprint(victim, vic)
      const ownBefore = a.ownUnchanged ? await c.fingerprint(attacker, own) : null
      r = await a.run(ctx)
      const after = await c.fingerprint(victim, vic)
      const ownAfter = a.ownUnchanged ? await c.fingerprint(attacker, own) : null
      const why: string[] = []
      if (is2xx(r)) why.push(`${r.status} (a write must never succeed)`)
      if (before !== after) why.push("B's fingerprint changed")
      if (ownBefore !== ownAfter) why.push("A's own fingerprint changed")
      passed = why.length === 0
      reason = passed ? `${r.status}, B unchanged` : `${why.join('; ')}: ${JSON.stringify(r.body).slice(0, 300)}`
    }
    attempts.push({ vector: a.vector, route: a.route, kind: a.kind, what: a.what, status: r.status, passed, reason })
  }
  return { ok: attempts.every((x) => x.passed), controls, attempts, own, victimRecord: vic }
}
