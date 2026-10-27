// packages/provisioning/src/requests.ts — the operator request kinds and the
// per-kind args checks (TASK-043d-1 D6, D11). PURE: the container's
// request-verify runs these on the trusted layer before the host-side
// executor runs any handler (ASVS 4.0.3 V4.1.1); the panel validates the same
// form for the operator's sake, but the database and this module are the
// lines that hold.
//
// The DB CHECK of plt.provisioning_request (platform 0005) and REQUEST_KINDS
// are the same list. A kind is RUN only when it is in HANDLED_KINDS (and the
// executor's registry.sh registers a handler for it); every other kind is
// refused "no handler (<owner task>)". Adding a kind's handler is: one entry
// in HANDLED_KINDS + one validator below + one handler file + one `register`
// line (TASK-031 import_members/seed_vertical, TASK-044 record_dpia/
// import_isolation, TASK-043d-2 the operate kinds).
import { validateCreate } from './customer.ts'
import { DEFAULT_DENY } from './operator-gate.ts'
import { ProvisioningError } from './errors.ts'
import { isPrintableText } from './printable-text.ts'

export const REQUEST_KINDS = [
  'create',
  'suspend',
  'resume',
  'reconcile',
  'enable_module',
  'disable_module',
  'import_members',
  'seed_vertical',
  'record_dpia',
  'import_isolation',
] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

/** Who ships the handler of each kind (the refusal names it). */
export const KIND_OWNER: Readonly<Record<RequestKind, string>> = Object.freeze({
  create: 'TASK-043d-1',
  suspend: 'TASK-043d-2',
  resume: 'TASK-043d-2',
  reconcile: 'TASK-043d-2',
  enable_module: 'TASK-043d-2',
  disable_module: 'TASK-043d-2',
  import_members: 'TASK-031',
  seed_vertical: 'TASK-031',
  record_dpia: 'TASK-044',
  import_isolation: 'TASK-044',
})

/** The kinds this release can run. */
export const HANDLED_KINDS: ReadonlySet<RequestKind> = new Set<RequestKind>(['create', 'import_members', 'seed_vertical'])

export const isRequestKind = (k: unknown): k is RequestKind => typeof k === 'string' && (REQUEST_KINDS as readonly string[]).includes(k)

/** One module's DPIA decision as the operator enters it with the create (C13 -> CreateSpec.dpia, TASK-044 D2). */
export interface DpiaDecision {
  requiresDpia: 'yes' | 'no'
  /** 1-20 snake_case codes (the library's own rule). */
  reasonCodes: string[]
  /** Required for every decision (brief Q3); never a placeholder. */
  documentRef: string
}

/** The normalised args of a `create` request. */
export interface CreateRequestArgs {
  slug: string
  host: string
  itAdmin: string
  councilAdmin: string
  /** The first body's name (default Rat in the engine). */
  bodyName: string | null
  /** The tenant config is ONLY a brand identity (materialize.ts requires both). */
  brand: { product: string; orgShort: string }
  enable: string[]
  dpia: Record<string, DpiaDecision>
}

/**
 * The normalised args of an `import_members` request (TASK-031). The member
 * list travels IN the request (a CSV text, at most 1 MiB), is handed to the
 * container on STDIN, and is PURGED from the row on any final state (platform
 * 0010). `validate` reads and reports; `apply` must name the sha256 the
 * validate reported.
 */
export interface ImportMembersArgs {
  slug: string
  phase: 'validate' | 'apply'
  vertical: string
  csv: string
  expectSha256?: string
}

/** The normalised args of a `seed_vertical` request (TASK-031). */
export interface SeedVerticalArgs {
  slug: string
  vertical: string
}

export type VerifiedRequestArgs = CreateRequestArgs | ImportMembersArgs | SeedVerticalArgs

export const IMPORT_LIST_MAX_BYTES = 1_048_576

export interface RequestEnvelope {
  kind: string
  customerSlug: string
  args: unknown
  operatorId: string
}

export type RequestVerdict = { verdict: 'ok'; args: VerifiedRequestArgs } | { verdict: 'refused'; reason: string }

export interface VerifyContext {
  /** Every module id of the catalogue (modules/<id>/module.json). */
  catalogueIds: readonly string[]
  /** modules/disabled.json ids: excluded from the default build, never enabled through a request. */
  disabledIds: readonly string[]
}

// the library's rule (assertDpiaDecisionInput): 1-20 codes, snake_case
const REASON_CODE = /^[a-z][a-z0-9_]{0,62}$/
const IMPORT_FIELDS = new Set(['slug', 'phase', 'vertical', 'csv', 'expectSha256'])
const SEED_FIELDS = new Set(['slug', 'vertical'])
const VERTICAL_ID = /^[a-z][a-z0-9-]{0,62}$/
const SHA256 = /^[0-9a-f]{64}$/
const CREATE_FIELDS = new Set(['slug', 'host', 'itAdmin', 'councilAdmin', 'bodyName', 'brand', 'enable', 'dpia'])

class Refused extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown, field: string, max: number): string {
  if (!isPrintableText(v, max)) {
    throw new Refused(`${field} must be 1 to ${max} printable characters`)
  }
  return v.trim()
}

function onlyFields(o: Record<string, unknown>, allowed: ReadonlySet<string>, prefix: string): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new Refused(`unknown field ${prefix}${k}`)
}

function dpiaOf(v: unknown, enable: readonly string[]): Record<string, DpiaDecision> {
  if (v === undefined || v === null) return {}
  if (!isObject(v)) throw new Refused('dpia must be an object of module id -> decision')
  const out: Record<string, DpiaDecision> = {}
  for (const [id, d] of Object.entries(v)) {
    if (!enable.includes(id)) throw new Refused(`dpia names ${id}, which is not enabled by this request`)
    if (!isObject(d)) throw new Refused(`dpia.${id} must be an object`)
    onlyFields(d, new Set(['requires_dpia', 'reason_codes', 'document_ref']), `dpia.${id}.`)
    if (typeof d.requires_dpia !== 'boolean') throw new Refused(`dpia.${id}.requires_dpia must be true or false`)
    if (!Array.isArray(d.reason_codes) || d.reason_codes.length < 1 || d.reason_codes.length > 20 || d.reason_codes.some((c) => typeof c !== 'string' || !REASON_CODE.test(c))) {
      throw new Refused(`dpia.${id}.reason_codes must be 1 to 20 snake_case codes (a-z 0-9 _, starting with a letter)`)
    }
    if (d.document_ref === null || d.document_ref === undefined || (typeof d.document_ref === 'string' && d.document_ref.trim() === '')) {
      throw new Refused(`dpia.${id}.document_ref is required: the written decision (TOM-annex entry) must be named for every module, whatever requires_dpia says`)
    }
    const ref = text(d.document_ref, `dpia.${id}.document_ref`, 500)
    // The ONE translation from the panel wire format (snake_case, boolean) to
    // the library's DpiaSpec, which create.sh writes verbatim as --dpia-json.
    out[id] = { requiresDpia: d.requires_dpia ? 'yes' : 'no', reasonCodes: [...d.reason_codes] as string[], documentRef: ref }
  }
  return out
}

function verticalOf(v: unknown): string {
  if (typeof v !== 'string' || !VERTICAL_ID.test(v)) throw new Refused('vertical must be a vertical id (a-z, 0-9, dashes)')
  return v
}

function verifyImportMembers(e: RequestEnvelope): ImportMembersArgs {
  if (!isObject(e.args)) throw new Refused('import_members args must be an object')
  const a = e.args
  onlyFields(a, IMPORT_FIELDS, '')
  if (a.slug !== e.customerSlug) throw new Refused(`args.slug ${String(a.slug)} is not the request's slug ${e.customerSlug}`)
  if (a.phase !== 'validate' && a.phase !== 'apply') throw new Refused('phase must be validate or apply')
  const vertical = verticalOf(a.vertical)
  if (typeof a.csv !== 'string' || a.csv.trim() === '') throw new Refused('csv must be the member list as text')
  if (Buffer.byteLength(a.csv, 'utf8') > IMPORT_LIST_MAX_BYTES) throw new Refused(`the member list exceeds ${IMPORT_LIST_MAX_BYTES} bytes`)
  if (a.phase === 'apply') {
    if (typeof a.expectSha256 !== 'string' || !SHA256.test(a.expectSha256)) {
      throw new Refused('an apply names the sha256 the validate reported (64 lowercase hex characters)')
    }
    return { slug: e.customerSlug, phase: 'apply', vertical, csv: a.csv, expectSha256: a.expectSha256 }
  }
  if (a.expectSha256 !== undefined) throw new Refused('a validate carries no expectSha256')
  return { slug: e.customerSlug, phase: 'validate', vertical, csv: a.csv }
}

function verifySeedVertical(e: RequestEnvelope): SeedVerticalArgs {
  if (!isObject(e.args)) throw new Refused('seed_vertical args must be an object')
  onlyFields(e.args, SEED_FIELDS, '')
  if (e.args.slug !== e.customerSlug) throw new Refused(`args.slug ${String(e.args.slug)} is not the request's slug ${e.customerSlug}`)
  return { slug: e.customerSlug, vertical: verticalOf(e.args.vertical) }
}

function verifyCreate(e: RequestEnvelope, ctx: VerifyContext): CreateRequestArgs {
  if (!isObject(e.args)) throw new Refused('create args must be an object')
  const a = e.args
  onlyFields(a, CREATE_FIELDS, '')
  if (a.slug !== e.customerSlug) throw new Refused(`args.slug ${String(a.slug)} is not the request's slug ${e.customerSlug}`)
  if (!Array.isArray(a.enable) || a.enable.some((m) => typeof m !== 'string')) throw new Refused('enable must be a list of module ids')
  if (!isObject(a.brand)) throw new Refused('brand must be an object with product and orgShort')
  onlyFields(a.brand, new Set(['product', 'orgShort']), 'brand.')
  const brand = { product: text(a.brand.product, 'brand.product', 80), orgShort: text(a.brand.orgShort, 'brand.orgShort', 20) }
  const bodyName = a.bodyName === undefined || a.bodyName === null ? null : text(a.bodyName, 'bodyName', 80)
  if (typeof a.itAdmin !== 'string' || typeof a.councilAdmin !== 'string' || typeof a.host !== 'string') {
    throw new Refused('host, itAdmin and councilAdmin must be strings')
  }
  // The engine's own validation, exactly as phase A runs it (no second copy):
  // slug, host, the operator uuid, the two administrators, the enable list
  // against the catalogue and the deny set (board, vault).
  const v = validateCreate(
    {
      slug: e.customerSlug,
      host: a.host,
      enable: a.enable as string[],
      operatorId: e.operatorId,
      admins: [
        { role: 'it-admin', email: a.itAdmin },
        { role: 'council-admin', email: a.councilAdmin },
      ],
    },
    ctx.catalogueIds,
  )
  for (const id of v.enable) {
    if (ctx.disabledIds.includes(id) && !DEFAULT_DENY.has(id)) throw new Refused(`module ${id} is disabled in this build (modules/disabled.json)`)
  }
  const admin = (role: string) => v.admins.find((x) => x.role === role)!.email
  return {
    slug: v.slug,
    host: v.host,
    itAdmin: admin('it-admin'),
    councilAdmin: admin('council-admin'),
    bodyName,
    brand,
    enable: v.enable,
    dpia: dpiaOf(a.dpia, v.enable),
  }
}

/**
 * The verdict on one request's kind and args: `ok` with the normalised args
 * the handler runs on, or `refused` with the reason the request is finished
 * with. Never throws for bad input (a programming error still throws).
 */
export function verifyRequestArgs(e: RequestEnvelope, ctx: VerifyContext): RequestVerdict {
  if (!isRequestKind(e.kind)) return { verdict: 'refused', reason: `unknown request kind ${e.kind}` }
  if (!HANDLED_KINDS.has(e.kind)) return { verdict: 'refused', reason: `no handler (${KIND_OWNER[e.kind]})` }
  try {
    if (e.kind === 'import_members') return { verdict: 'ok', args: verifyImportMembers(e) }
    if (e.kind === 'seed_vertical') return { verdict: 'ok', args: verifySeedVertical(e) }
    return { verdict: 'ok', args: verifyCreate(e, ctx) }
  } catch (err) {
    if (err instanceof Refused || err instanceof ProvisioningError) return { verdict: 'refused', reason: err.message }
    throw err
  }
}

/**
 * The create's pre-flight that needs the platform database: every enabled
 * module has the plt.module_version row `init` loaded (Q20), checked before
 * phase A writes anything. Null when all are loaded, else the reason.
 */
export async function verifyEnableLoaded(enable: readonly string[], unloaded: (ids: readonly string[]) => Promise<string[]>): Promise<string | null> {
  if (!enable.length) return null
  const missing = await unloaded(enable)
  return missing.length ? `module(s) ${missing.join(', ')} have no plt.module_version (gremion-tenant init loaded none: undecided under Q20)` : null
}
