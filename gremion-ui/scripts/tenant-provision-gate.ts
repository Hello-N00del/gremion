// gremion-ui/scripts/tenant-provision-gate.ts
// TASK-044's verbs of the tenant-create one-shot (lane note D3, waves O9: one
// file per lane; tenant-provision.ts holds one import and the case lines).
// Each verb DELEGATES to @gremion/provisioning / lifecycle/enable-gate; the
// panel's executor (TASK-043d) reaches the same functions through its request
// kinds (enable-module, record_dpia, import_isolation).
//
//   enable-module <slug> <module> --operator <uuid> [--dpia-json <file>]
//       one module for an existing customer through the level-1 gate
//   dpia-record <slug> <module> --operator <uuid> --requires-dpia yes|no|not_applicable
//               --reason-codes a,b --document-ref <TOM-annex entry>
//       the dated, written DPIA-applicability decision (TRD-161, brief Q3)
//   isolation-record <file>
//       imports verify's stamped isolation evidence (scripts/verify/out/isolation/<sha>.json)
//   gate-status [<slug>]
//       the release tip, the enabled modules not proven on it, the TASK-043
//       interim attestations, and whether the isolation keys are validated (JSON)
//   regate <slug> <module> --operator <uuid>
//       re-gates one enabled module (lane note A3), then validates the keys
//
// The release tip is never a flag or a payload field (lane note A6): it is
// GREMION_RELEASE_TIP, which gremion-tenant derives on the host from the
// H10-authenticated release tree. A refusal is an EnableRefused: exit 1 with
// its code and reason on stderr (tenant-provision.ts's exit mapping).
import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import {
  attestedEnablements,
  enableCustomerModule,
  EnableRefused,
  recordDpiaDecision,
  recordIsolationResults,
  regateEnablement,
  unprovenEnablements,
  validateGateForeignKeys,
  type DpiaSpec,
  type ProvisioningDeps,
} from '@gremion/provisioning'
import { LifecycleError } from '@gremion/tenant-store/lifecycle'

export { EnableRefused }

/** The verbs this file answers (tenant-provision.ts's case lines). */
export const GATE_VERBS: ReadonlySet<string> = new Set(['enable-module', 'dpia-record', 'isolation-record', 'gate-status', 'regate'])

export const GATE_USAGE = `  enable-module <slug> <module> --operator <uuid> [--dpia-json <file>]
  dpia-record <slug> <module> --operator <uuid> --requires-dpia yes|no|not_applicable --reason-codes a,b --document-ref <ref>
  isolation-record <file> | gate-status [<slug>] | regate <slug> <module> --operator <uuid>`

/** What tenant-provision.ts hands over: its env contract, flag parser and pools. */
export interface GateVerbContext {
  /** GREMION_RELEASE_TIP (40/64 lowercase hex) or null. */
  releaseTip(): string | null
  withLive<T>(opts: { needEdge?: boolean }, fn: (deps: ProvisioningDeps) => Promise<T>): Promise<T>
  /** A direct pool to gremion_platform (PLATFORM_DATABASE_URL); the caller of this function ends it. */
  openPlatform(): postgres.Sql
  /** The customer id of a slug from the control registry, or null. */
  customerIdForSlug(slug: string): Promise<string | null>
  flag(name: string): string | undefined
  reqFlag(name: string): string
  positional(index?: number): string | undefined
  /** A usage error (exit 2, named). */
  usage(message: string): Error
  log(line: string): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function operatorId(ctx: GateVerbContext): string {
  const id = ctx.reqFlag('--operator')
  if (!UUID.test(id)) throw ctx.usage(`--operator must be the operator's ops-realm user id (a lowercase uuid), not ${JSON.stringify(id)}`)
  return id
}

function arg(ctx: GateVerbContext, index: number, what: string, verb: string): string {
  const v = ctx.positional(index)
  if (!v) throw ctx.usage(`${verb} requires <${what}>`)
  return v
}

function readJsonFile(ctx: GateVerbContext, path: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    throw ctx.usage(`${what} ${path} cannot be read (${err instanceof Error ? err.message : String(err)})`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw ctx.usage(`${what} ${path} is not JSON`)
  }
}

/** --dpia-json <file>: {requiresDpia, reasonCodes, documentRef} (validated by the library). */
export function readDpiaSpec(ctx: GateVerbContext): DpiaSpec | undefined {
  const path = ctx.flag('--dpia-json')
  if (!path) return undefined
  const j = readJsonFile(ctx, path, '--dpia-json') as Partial<DpiaSpec> | null
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw ctx.usage('--dpia-json must hold one object {requiresDpia, reasonCodes, documentRef}')
  return { requiresDpia: j.requiresDpia as DpiaSpec['requiresDpia'], reasonCodes: Array.isArray(j.reasonCodes) ? j.reasonCodes : [], documentRef: j.documentRef as string }
}

async function withPlatform<T>(ctx: GateVerbContext, fn: (platform: postgres.Sql) => Promise<T>): Promise<T> {
  const platform = ctx.openPlatform()
  try {
    return await fn(platform)
  } finally {
    await platform.end({ timeout: 5 })
  }
}

async function requireCustomerId(ctx: GateVerbContext, slug: string): Promise<string> {
  const id = await ctx.customerIdForSlug(slug)
  if (!id) throw ctx.usage(`unknown customer ${JSON.stringify(slug)}`)
  return id
}

/** A LifecycleError INVALID_INPUT is the operator's input: a usage error (exit 2). */
function asUsage(ctx: GateVerbContext, err: unknown): never {
  if (err instanceof LifecycleError && err.code === 'INVALID_INPUT') throw ctx.usage(err.message)
  throw err
}

async function cmdEnableModule(ctx: GateVerbContext): Promise<void> {
  const slug = arg(ctx, 0, 'slug', 'enable-module')
  const moduleKey = arg(ctx, 1, 'module', 'enable-module')
  const op = operatorId(ctx)
  const dpia = readDpiaSpec(ctx)
  await ctx.withLive({}, async (deps) => {
    const r = await enableCustomerModule(slug, moduleKey, { operatorId: op, ...(dpia ? { dpia } : {}) }, deps)
    ctx.log(`enable-module ${slug} ${r.moduleKey} by operator ${op}: ${r.noop ? 'already enabled' : 'enabled'}${r.database ? ` (${r.database})` : ''}; broker ${r.reloaded ? 'reloaded' : 'unchanged'}`)
    console.log(JSON.stringify({ verb: 'enable-module', slug, module: r.moduleKey, noop: r.noop, database: r.database, enabled: r.enabled, operatorId: op }))
  })
}

async function cmdDpiaRecord(ctx: GateVerbContext): Promise<void> {
  const slug = arg(ctx, 0, 'slug', 'dpia-record')
  const moduleKey = arg(ctx, 1, 'module', 'dpia-record')
  const op = operatorId(ctx)
  const documentRef = ctx.flag('--document-ref')
  if (!documentRef) throw ctx.usage('dpia-record requires --document-ref <TOM-annex entry>: the decision is written down, whatever --requires-dpia says (TRD-161, brief Q3)')
  const requiresDpia = ctx.reqFlag('--requires-dpia') as DpiaSpec['requiresDpia']
  const reasonCodes = ctx.reqFlag('--reason-codes').split(',').map((s) => s.trim()).filter(Boolean)
  const customerId = await requireCustomerId(ctx, slug)
  await withPlatform(ctx, async (platform) => {
    const r = await recordDpiaDecision(platform, { customerId, moduleKey, requiresDpia, reasonCodes, documentRef, decidedBy: { kind: 'operator', id: op } }).catch((e: unknown) => asUsage(ctx, e))
    ctx.log(`dpia-record ${slug} ${moduleKey} by operator ${op}: decision ${r.dpiaDecisionId} recorded`)
    console.log(JSON.stringify({ verb: 'dpia-record', slug, module: moduleKey, dpiaDecisionId: r.dpiaDecisionId, requiresDpia, operatorId: op }))
  })
}

async function cmdIsolationRecord(ctx: GateVerbContext): Promise<void> {
  const path = arg(ctx, 0, 'file', 'isolation-record')
  const json = readJsonFile(ctx, path, 'the evidence file')
  await withPlatform(ctx, async (platform) => {
    const r = await recordIsolationResults(platform, json)
    ctx.log(`isolation-record ${path}: ${r.inserted.length} result(s) recorded, ${r.existing.length} already present`)
    console.log(JSON.stringify({ verb: 'isolation-record', inserted: r.inserted, existing: r.existing }))
  })
}

async function cmdGateStatus(ctx: GateVerbContext): Promise<void> {
  const slug = ctx.positional(0)
  const customerId = slug ? await requireCustomerId(ctx, slug) : undefined
  const tip = ctx.releaseTip()
  await withPlatform(ctx, async (platform) => {
    const unproven = await unprovenEnablements({ platform, releaseTipSha: tip, ...(customerId ? { customerId } : {}) })
    const attested = (await attestedEnablements(platform)).filter((a) => !customerId || a.customerId === customerId)
    const keys = await platform<{ name: string; validated: boolean }[]>`
      SELECT conname AS name, convalidated AS validated FROM pg_constraint
       WHERE conrelid = 'plt.module_enablement'::regclass AND conname LIKE '%_kind_passed_fkey' ORDER BY 1`
    ctx.log(`gate-status${slug ? ` ${slug}` : ''}: release tip ${tip ?? 'UNSET'}; ${unproven.length} unproven enablement(s); ${attested.length} interim attestation(s)`)
    console.log(JSON.stringify({ verb: 'gate-status', slug: slug ?? null, releaseTip: tip, proven: unproven.length === 0, unproven, attested, keys }))
  })
}

async function cmdRegate(ctx: GateVerbContext): Promise<void> {
  const slug = arg(ctx, 0, 'slug', 'regate')
  const moduleKey = arg(ctx, 1, 'module', 'regate')
  const op = operatorId(ctx)
  const customerId = await requireCustomerId(ctx, slug)
  await withPlatform(ctx, async (platform) => {
    const r = await regateEnablement({ platform, releaseTipSha: ctx.releaseTip(), customerId, moduleKey, actor: { kind: 'operator', id: op } })
    const keys = await validateGateForeignKeys(platform)
    ctx.log(`regate ${slug} ${moduleKey} by operator ${op}: ${r.updated ? 'references replaced' : 'already current'}; keys validated [${keys.validated.join(', ')}], pending [${keys.pending.map((p) => `${p.name}:${p.violators}`).join(', ')}]`)
    console.log(JSON.stringify({ verb: 'regate', slug, module: moduleKey, ...r, keys }))
  })
}

/** Dispatches one of GATE_VERBS. */
export async function runGateVerb(verb: string, ctx: GateVerbContext): Promise<void> {
  switch (verb) {
    case 'enable-module':
      return cmdEnableModule(ctx)
    case 'dpia-record':
      return cmdDpiaRecord(ctx)
    case 'isolation-record':
      return cmdIsolationRecord(ctx)
    case 'gate-status':
      return cmdGateStatus(ctx)
    case 'regate':
      return cmdRegate(ctx)
    default:
      throw ctx.usage(`unknown gate verb ${verb}`)
  }
}

/** tenant-provision.ts's exit mapping: a refusal is exit 1 with `code` and `reason` on stderr, never a usage error. */
export function refusalLine(err: unknown): string | null {
  return err instanceof EnableRefused ? `REFUSED ${err.code}: ${err.reason}` : null
}
