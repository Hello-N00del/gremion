// sync.ts — make etc/edge a faithful projection of the tenant registry.
//
// Ported from B18 edge-sync.ts (StuRaOS) with its security argument intact:
// this runs HOST-SIDE, called by the control plane (TASK-043's provisioner).
// The internet-facing app process holds no mount of etc/edge at all — Traefik's
// read-only bind is the only one (hygiene j4) — so no app-level compromise can
// publish a Host() router pointing a hostname at anything.
//
// Guarantees:
//   * IDEMPOTENT IN EFFECT: unchanged documents are not rewritten (emit.ts), so a
//     scheduled re-run does not bounce Traefik's dynamic configuration.
//   * A PROJECTION IN BOTH DIRECTIONS: a non-routable tenant's file is removed,
//     and on a prune pass a tenant-*.yml nobody claims is removed too.
//   * ALL-OR-NOTHING ON CONFLICT (TRD-074, edge half): one host = one router in
//     ONE tenant's file. Every tenant is rendered first (pure) and every claim —
//     hosts, router names, middleware names — is resolved fleet-wide BEFORE the
//     first file is touched. A host under two tenants, or a name two tenants
//     would both declare, throws and writes neither file.
//
// Not ported: B18's vault-host claims (Vaultwarden routing is not this
// emitter's; one host = one router) and the CLI formatting prose beyond the
// operator table.

import * as fs from 'node:fs'
import { join } from 'node:path'
import { assertSlug, ROUTER_FILE_RE, validateSlug } from './names.js'
import { emitTenantRouterFile, removeTenantRouterFile, type EmitAction, type EmitIo } from './emit.js'
import { renderTenantRouter, type HostPolicy, type RouterSkip, type TenantDomain } from './render.js'

/** gremion-ui registry TenantStatus, restated (the package imports nothing from gremion-ui). */
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted'

/**
 * The ONE place that decides whether a tenant owns a router file.
 * `suspended` routes on purpose: the edge decides tenant IDENTITY, the app
 * decides tenant STATE and serves the branded 503. `provisioning` has no data
 * plane yet; `deleting`/`deleted` are tombstones whose hosts may already be
 * someone else's (identifier reuse / takeover) — a leftover router is the risk.
 */
export const ROUTABLE_STATUSES: ReadonlySet<TenantStatus> = new Set<TenantStatus>(['active', 'suspended'])

/** Every status the registry can hold. Anything else is enum drift and THROWS:
 *  treating an unknown value as "not routable" would silently delete a live
 *  tenant's router file. */
export const TENANT_STATUSES: ReadonlySet<string> = new Set<TenantStatus>([
  'provisioning',
  'active',
  'suspended',
  'deleting',
  'deleted',
])

export function isRoutableStatus(status: TenantStatus): boolean {
  return ROUTABLE_STATUSES.has(status)
}

export interface EdgeSyncTenant {
  readonly slug: string
  readonly status: TenantStatus
  readonly domains: readonly TenantDomain[]
}

export interface SyncTenantRoutersOptions extends HostPolicy {
  /** For a fleet pass: EVERY tenant row, including non-routable ones. */
  readonly tenants: readonly EdgeSyncTenant[]
  readonly dynamicDir: string
  readonly certResolver: string
  /** Remove tenant-*.yml files no listed tenant claims. Fleet passes only. */
  readonly prune?: boolean
  readonly dryRun?: boolean
  /** Write only these slugs; every listed tenant still contributes its claims. */
  readonly emitOnly?: readonly string[]
  readonly io?: Partial<EmitIo>
}

export interface EdgeSyncRow {
  readonly slug: string
  readonly status: TenantStatus
  readonly routable: boolean
  readonly action: EmitAction
  readonly path: string
  readonly hosts: readonly string[]
  readonly skipped: readonly RouterSkip[]
  /** A ROUTABLE tenant that answers nowhere — a live outage, not a warning. */
  readonly dark: boolean
}

export interface EdgeSyncReport {
  readonly rows: readonly EdgeSyncRow[]
  /** tenant-*.yml removed (or, dry run, that would be) because nobody claims them. */
  readonly orphans: readonly string[]
  readonly hostCount: number
  readonly changed: boolean
  readonly dryRun: boolean
  readonly dynamicDir: string
}

/** Record `key -> slug`, throwing when a DIFFERENT slug already holds it. */
function claim(map: Map<string, string>, key: string, slug: string, what: string): void {
  const prior = map.get(key)
  if (prior !== undefined && prior !== slug) {
    throw new Error(
      `syncTenantRouters: ${what} "${key}" is claimed by BOTH "${prior}" and "${slug}" — one host is one ` +
        "router in ONE tenant's file (TRD-074); refusing to write either file",
    )
  }
  map.set(key, slug)
}

export function syncTenantRouters(opts: SyncTenantRoutersOptions): EdgeSyncReport {
  const prune = opts.prune === true
  const dryRun = opts.dryRun === true
  if (!Array.isArray(opts.tenants)) throw new Error('syncTenantRouters: tenants must be an array')

  const slugs = new Set<string>()
  for (const t of opts.tenants) {
    const slug = assertSlug(t?.slug, 'syncTenantRouters')
    if (!TENANT_STATUSES.has(t.status)) {
      throw new Error(`syncTenantRouters: tenant "${slug}" has unknown status ${JSON.stringify(t.status)} — refusing to guess whether it routes`)
    }
    if (!Array.isArray(t.domains)) throw new Error(`syncTenantRouters: tenant "${slug}" domains must be an array`)
    if (slugs.has(slug)) {
      throw new Error(`syncTenantRouters: slug "${slug}" appears twice in the tenant list — refusing to pick a winner`)
    }
    slugs.add(slug)
  }

  if (prune && opts.tenants.length === 0) {
    throw new Error(
      'syncTenantRouters: refusing to prune against an EMPTY tenant list — that deletes every tenant file; ' +
        'an empty registry read is far more likely a failed read than a fleet with no tenants',
    )
  }

  let emitOnly: ReadonlySet<string> | null = null
  if (opts.emitOnly) {
    if (prune) throw new Error('syncTenantRouters: `prune` and `emitOnly` are mutually exclusive')
    const only = new Set<string>()
    for (const s of opts.emitOnly) {
      const slug = assertSlug(s, 'syncTenantRouters emitOnly')
      if (!slugs.has(slug)) throw new Error(`syncTenantRouters: emitOnly names "${slug}", which is not in the tenant list`)
      only.add(slug)
    }
    emitOnly = only
  }

  // ── Before ANY file is touched: every claim, fleet-wide ─────────────────────
  // Hosts are claimed from EVERY status: a provisioning tenant is about to serve
  // on its host, and a tombstone's host must stay unservable. Names are claimed
  // only by tenants that will own a file.
  const policy = { normaliseHost: opts.normaliseHost, isReservedHost: opts.isReservedHost, certResolver: opts.certResolver }
  const hostOwner = new Map<string, string>()
  const nameOwner = new Map<string, string>()
  for (const t of opts.tenants) {
    for (const d of t.domains) {
      const h = typeof d?.host === 'string' ? opts.normaliseHost(d.host) : null
      if (h) claim(hostOwner, h, t.slug, 'host')
    }
    if (!isRoutableStatus(t.status)) continue
    const plan = renderTenantRouter({ slug: t.slug, domains: t.domains, ...policy })
    for (const r of plan.routers) {
      claim(nameOwner, r.name, t.slug, 'router name')
      claim(nameOwner, r.pin, t.slug, 'middleware name')
    }
    if (plan.routers.length > 0) claim(nameOwner, `edge-perip-${t.slug}`, t.slug, 'middleware name')
  }

  // ── …and every claim ALREADY ON DISK by a tenant this pass was not given ────
  // A single-tenant caller that passes only its own row would otherwise write a
  // file whose router/middleware names or hosts collide with another tenant's
  // existing file; Traefik keeps one definition and skips the other, taking a
  // host dark. On a prune pass those files are orphans about to be removed.
  if (!prune) {
    for (const c of onDiskClaims(opts.dynamicDir, slugs)) {
      for (const h of c.hosts) {
        const n = opts.normaliseHost(h)
        if (n) claim(hostOwner, n, c.slug, 'host')
      }
      for (const n of c.names) claim(nameOwner, n, c.slug, 'router/middleware name')
    }
  }

  const rows: EdgeSyncRow[] = []
  let changed = false
  for (const t of opts.tenants) {
    if (emitOnly && !emitOnly.has(t.slug)) continue
    const routable = isRoutableStatus(t.status)
    // A non-routable tenant is emitted with NO domains: the same remove path,
    // the same atomicity, the same dry-run semantics — no second deletion path.
    const res = emitTenantRouterFile({
      slug: t.slug,
      domains: routable ? t.domains : [],
      dynamicDir: opts.dynamicDir,
      dryRun,
      ...(opts.io ? { io: opts.io } : {}),
      ...policy,
    })
    if (res.action === 'written' || res.action === 'removed') changed = true
    rows.push({
      slug: t.slug,
      status: t.status,
      routable,
      action: res.action,
      path: res.path,
      hosts: res.hosts,
      skipped: routable ? res.skipped : [],
      dark: routable && res.hosts.length === 0,
    })
  }

  const orphans: string[] = []
  if (prune) {
    const dir = fs.realpathSync(opts.dynamicDir)
    for (const name of fs.readdirSync(dir).sort()) {
      const m = ROUTER_FILE_RE.exec(name)
      if (!m?.[1] || slugs.has(m[1])) continue // not ours (tls.yml, *.tmp, active.yml) or claimed
      const path = join(dir, name)
      if (!fs.lstatSync(path).isFile()) continue // never follow or remove a non-file
      orphans.push(name)
      changed = true
      if (dryRun) continue
      if (validateSlug(m[1]).ok) removeTenantRouterFile(m[1], dir, opts.io)
      else fs.unlinkSync(path) // an owned-shape name no valid slug can emit
    }
  }

  return {
    rows,
    orphans,
    hostCount: rows.reduce((n, r) => n + r.hosts.length, 0),
    changed,
    dryRun,
    dynamicDir: opts.dynamicDir,
  }
}

interface DiskClaim {
  readonly slug: string
  readonly hosts: readonly string[]
  readonly names: readonly string[]
}

/**
 * Router/middleware names and Host() literals declared by the tenant-*.yml
 * files on disk whose slug is NOT in `listed`. Read in the emitter's own fixed
 * shape (four-space keys under `routers:`/`middlewares:`, `rule: "Host(...)"`);
 * a file that is not a regular file is skipped here and never touched.
 */
function onDiskClaims(dynamicDir: string, listed: ReadonlySet<string>): DiskClaim[] {
  const dir = fs.realpathSync(dynamicDir)
  const out: DiskClaim[] = []
  for (const name of fs.readdirSync(dir).sort()) {
    const m = ROUTER_FILE_RE.exec(name)
    if (!m?.[1] || listed.has(m[1])) continue
    const path = join(dir, name)
    if (!fs.lstatSync(path).isFile()) continue
    const hosts: string[] = []
    const names: string[] = []
    let section = ''
    for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
      const sec = /^ {2}([A-Za-z]+):\s*$/.exec(line)
      if (sec?.[1]) {
        section = sec[1]
        continue
      }
      const key = /^ {4}([A-Za-z0-9_.-]+):\s*$/.exec(line)
      if (key?.[1] && (section === 'routers' || section === 'middlewares')) names.push(key[1])
      for (const h of line.matchAll(/Host\(`([^`]+)`\)/g)) if (h[1]) hosts.push(h[1])
    }
    out.push({ slug: m[1], hosts, names })
  }
  return out
}

/** The operator table. Skipped hosts are printed one per line, never summarised. */
export function formatEdgeSyncReport(report: EdgeSyncReport): string[] {
  const lines = [`edge sync${report.dryRun ? ' (DRY RUN — nothing written)' : ''} — ${report.dynamicDir}`]
  for (const r of report.rows) {
    const what = !r.routable
      ? `(status=${r.status} is not routable — no router)`
      : r.hosts.length > 0
        ? r.hosts.join(', ')
        : '(no routable host)'
    lines.push(`  ${r.action.padEnd(9)} ${r.slug.padEnd(16)} ${what}`)
    for (const s of r.skipped) lines.push(`             host ${JSON.stringify(s.host)} got NO router (${s.code}) — ${s.reason}`)
    if (r.dark) lines.push(`             "${r.slug}" is ${r.status.toUpperCase()} with no routable host: it answers NOWHERE`)
  }
  for (const o of report.orphans) lines.push(`  ${(report.dryRun ? 'would-rm' : 'pruned').padEnd(9)} ${o} — no tenant claims it`)
  lines.push(
    `  ${report.rows.length} tenant(s), ${report.hostCount} host router(s), ${report.orphans.length} orphan(s); ` +
      `${report.changed ? 'CHANGED' : 'already in sync'}.`,
  )
  return lines
}

