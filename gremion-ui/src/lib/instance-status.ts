// src/lib/instance-status.ts
//
// #264 — provisioning convergence (the Systemstatus surface engineering is gated
// on). The instance is two planes (#202): a SHARED control-plane (one app image /
// edge / module registry for every tenant) and a per-tenant SILO data-plane (its
// own Postgres, Keycloak realm, Nextcloud, Matrix). Provisioning "converges" when
// every silo service for the realm is up.
//
// This module is the CLIENT-SAFE presentation contract — labels, tones, icons,
// and the per-state service snapshot — mirrored 1:1 from the prototype
// web/tenancy.jsx + web/systemstatus.jsx. The SERVER maps the real backend state
// (tenant.status + per-tenant readiness + the tenant_provisioning_resource
// ledger) onto these shapes in $lib/server/tenant/instance-state.ts; the
// Systemstatus page, the topbar convergence badge, and the dashboard banner all
// render from here. NO server-only imports.
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import type { ModuleManifest } from '$lib/modules/types'

/** The four overall states the backend convergence machine reports. */
export type InstanceState = 'provisioning' | 'ready' | 'degraded' | 'failed'

/** Per-service status within a snapshot. */
export type ServiceStatus = 'ok' | 'provisioning' | 'queued' | 'degraded' | 'failed'

export type ServicePlane = 'shared' | 'silo'

export interface InstanceService {
  key: string
  name: string
  plane: ServicePlane
  tech: string
  detail: string
}

/** Overall-state presentation (tone drives pill colour + glyph). */
export interface InstanceStateMeta {
  label: string
  tone: 'success' | 'warn' | 'danger'
  icon: string
  eyebrow: string
  headline: string
  sub: string
}

export const INSTANCE_STATE_META: Record<InstanceState, InstanceStateMeta> = {
  ready: {
    label: 'Bereit',
    tone: 'success',
    icon: 'check',
    eyebrow: 'Konvergiert',
    headline: 'Alle Dienste dieser Instanz laufen.',
    sub: 'Eigene Datenebene vollständig bereitgestellt, an die geteilte Steuerebene angebunden.',
  },
  provisioning: {
    label: 'Bereitstellung',
    tone: 'warn',
    icon: 'clock',
    eyebrow: 'Konvergiert noch',
    headline: 'Instanz wird bereitgestellt.',
    sub: 'Die Datenebene dieses Mandanten wird erstellt. Anmeldung erst nach Konvergenz aller Silo-Dienste möglich.',
  },
  degraded: {
    label: 'Eingeschränkt',
    tone: 'warn',
    icon: 'alert-triangle',
    eyebrow: 'Teilausfall',
    headline: 'Instanz läuft mit eingeschränkten Diensten.',
    sub: 'Kernfunktionen erreichbar. Ein Silo-Dienst ist gestört — betroffene Funktion verzögert, nicht blockiert.',
  },
  failed: {
    label: 'Fehler',
    tone: 'danger',
    icon: 'alert-triangle',
    eyebrow: 'Konvergenz gescheitert',
    headline: 'Bereitstellung fehlgeschlagen.',
    sub: 'Ein kritischer Silo-Dienst konnte nicht erstellt werden. Bis zur Behebung ist die Instanz nicht nutzbar.',
  },
}

/** The six services: two shared control-plane, four silo data-plane. */
export const SERVICES: readonly InstanceService[] = [
  { key: 'app', name: 'Anwendung & Edge', plane: 'shared', tech: 'SvelteKit · Caddy', detail: 'Geteiltes Image · Routing nach Realm' },
  { key: 'registry', name: 'Modul-Registry', plane: 'shared', tech: 'module-manifest (#201)', detail: 'Aktive Module dieses Mandanten' },
  { key: 'db', name: 'PostgreSQL', plane: 'silo', tech: 'eigenes Schema', detail: 'Eigene Datenbank · keine geteilten Zeilen' },
  { key: 'keycloak', name: 'Keycloak-Realm', plane: 'silo', tech: 'eigener Realm', detail: 'Identitäten, Rollen, SSO' },
  { key: 'nextcloud', name: 'Nextcloud', plane: 'silo', tech: 'Dateien · CalDAV', detail: 'Dokumente und Kalender' },
  // tech is tenant-agnostic on purpose (the status page is per-tenant; the
  // concrete homeserver/realm live in the tenant config, not in source).
  { key: 'matrix', name: 'Matrix-Homeserver', plane: 'silo', tech: 'Synapse · Föderation', detail: 'Chat und hybride Sitzungen' },
]

/** The silo subsystems the backend ledger (tenant_provisioning_resource) tracks,
 *  mapped to the SERVICES key (the ledger calls Keycloak "realm"). */
export const SILO_SUBSYSTEM_TO_SERVICE: Record<string, string> = {
  db: 'db',
  realm: 'keycloak',
  nextcloud: 'nextcloud',
  matrix: 'matrix',
}

/** Per-state service snapshot (the convergence log the page renders). */
export const SERVICE_SNAPSHOTS: Record<InstanceState, Record<string, ServiceStatus>> = {
  ready: { app: 'ok', registry: 'ok', db: 'ok', keycloak: 'ok', nextcloud: 'ok', matrix: 'ok' },
  provisioning: { app: 'ok', registry: 'ok', db: 'provisioning', keycloak: 'provisioning', nextcloud: 'queued', matrix: 'queued' },
  degraded: { app: 'ok', registry: 'ok', db: 'ok', keycloak: 'ok', nextcloud: 'ok', matrix: 'degraded' },
  failed: { app: 'ok', registry: 'ok', db: 'ok', keycloak: 'failed', nextcloud: 'queued', matrix: 'queued' },
}

/** State-aware per-service one-line note so the page reads like a real log. */
export const SERVICE_MESSAGES: Partial<Record<InstanceState, Record<string, string>>> = {
  provisioning: {
    db: 'Datenbank wird angelegt · Migrationen laufen',
    keycloak: 'Realm wird erstellt · Rollen werden importiert',
    nextcloud: 'Wartet auf Datenbank',
    matrix: 'Wartet auf Realm',
  },
  degraded: {
    matrix: 'Föderation gestört · Chat verzögert, Anmeldung unberührt',
  },
  failed: {
    keycloak: 'Realm-Import fehlgeschlagen · Anmeldung blockiert',
    nextcloud: 'Übersprungen · wartet auf Realm',
    matrix: 'Übersprungen · wartet auf Realm',
  },
}

/** Status-tone → pill class + glyph (pill-icon contract, CR-3). The repo has no
 *  `.pill-neutral`; the base `.pill` IS neutral, so `cls:''` renders the base. */
export const STATUS_PILL: Record<ServiceStatus, { cls: string; icon: string; label: string }> = {
  ok: { cls: 'pill-success', icon: 'check', label: 'Bereit' },
  provisioning: { cls: 'pill-warn', icon: 'clock', label: 'Bereitstellung' },
  queued: { cls: '', icon: 'clock', label: 'Wartet' },
  degraded: { cls: 'pill-warn', icon: 'alert-triangle', label: 'Eingeschränkt' },
  failed: { cls: 'pill-danger', icon: 'alert-triangle', label: 'Fehler' },
}

/** Service-key → Icon name. (The repo Icon set lacks layers/grid/database/server;
 *  package/sliders/archive are the closest in-set glyphs.) */
export const SERVICE_ICON: Record<string, string> = {
  app: 'package',
  registry: 'sliders',
  db: 'archive',
  keycloak: 'key',
  nextcloud: 'folder',
  matrix: 'matrix',
}

export interface ResolvedService extends InstanceService {
  status: ServiceStatus
  message: string
}

/**
 * Resolve the full per-service snapshot for an overall state. `realStatuses`
 * (optional) overrides the static snapshot with the actual ledger status of any
 * silo service whose row exists — so a converged default tenant shows all-ok and
 * a real failure shows the failed row, while still honouring the prototype
 * snapshot for services with no ledger row (e.g. the always-on shared plane).
 */
export function instanceServices(
  state: InstanceState,
  realStatuses?: Partial<Record<string, ServiceStatus>>,
): ResolvedService[] {
  const snap = SERVICE_SNAPSHOTS[state] ?? SERVICE_SNAPSHOTS.ready
  const msgs = SERVICE_MESSAGES[state] ?? {}
  return SERVICES.map((s) => {
    const status = realStatuses?.[s.key] ?? snap[s.key] ?? 'ok'
    return { ...s, status, message: msgs[s.key] ?? s.detail }
  })
}

/** Derive the overall state from a set of silo service statuses (server uses this
 *  when real ledger rows exist). all ok → ready; any failed → failed; any
 *  pending/provisioning → provisioning; only matrix down → degraded. */
export function overallFromSilo(silo: Record<string, ServiceStatus>): InstanceState {
  const vals = Object.entries(silo)
  if (vals.every(([, v]) => v === 'ok')) return 'ready'
  if (vals.some(([, v]) => v === 'failed')) return 'failed'
  // A single non-critical silo (matrix) degraded, everything else ok → degraded.
  const nonOk = vals.filter(([, v]) => v !== 'ok')
  if (nonOk.length === 1 && nonOk[0][0] === 'matrix' && nonOk[0][1] === 'degraded') return 'degraded'
  return 'provisioning'
}

/** True when the instance is fully converged (badge/banner show only when not). */
export function instanceReady(state: InstanceState | null | undefined): boolean {
  return (state ?? 'ready') === 'ready'
}

// ── The Systemstatus "Aktive Module" catalog ─────────────────────────────────
// DERIVED from the registered manifests, never hand-listed. The hand-written
// version outlived the modules it described: it advertised finance, elections,
// Kalender, Dokumente, Matrix·Chat and Aufgaben as this instance's modules long
// after the open-core carve removed every one of them, so the status page —
// the page whose entire job is to say what is running — was the least accurate
// page in the app. An instance now shows exactly what it registers: a kernel
// with no feature modules shows an empty "Aktive Module" list, which is the
// true answer.
export interface PluggableModule {
  id: string
  label: string
  service: string
  note: string
}

function describe(m: ModuleManifest): PluggableModule {
  return {
    id: m.id,
    label: m.status?.label ?? m.id,
    service: m.status?.service ?? '',
    note: m.status?.note ?? '',
  }
}

/** Modules the tenant can switch off (manifests with `toggleable: true`). */
export const PLUGGABLE_MODULES: readonly PluggableModule[] = MODULE_MANIFESTS.filter(
  (m) => m.toggleable,
).map(describe)

/** Always-on modules (not abwählbar) — shown as the "Kernmodule" card. */
export const CORE_MODULES: readonly PluggableModule[] = MODULE_MANIFESTS.filter(
  (m) => !m.toggleable,
).map(describe)

/** Labels of the always-on modules, in registration order. */
export const CORE_MODULE_LABELS: readonly string[] = CORE_MODULES.map((m) => m.label)
