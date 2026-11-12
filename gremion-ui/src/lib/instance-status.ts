// src/lib/instance-status.ts
//
// #264 — presentation contract for the overall instance state that the shell
// (topbar convergence badge, dashboard banner) shows while a tenant is not yet
// ready: labels, tones and icons for the four states. The SERVER maps the real
// per-tenant boot readiness onto these in $lib/server/tenant/instance-state.ts.
// NO server-only imports.
//
// E3: the Systemstatus page no longer reads from here. It shows live probe results
// (src/routes/systemstatus/), so the per-service snapshot, the canned per-state
// messages and the provisioning-ledger helpers that fed it were removed together
// with the claims they made.
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import type { ModuleManifest } from '$lib/modules/types'

/** The four overall states the backend convergence machine reports. */
export type InstanceState = 'provisioning' | 'ready' | 'degraded' | 'failed'

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
