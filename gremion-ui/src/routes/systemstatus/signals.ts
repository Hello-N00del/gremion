// E3 (finding 4): Systemstatus rows and headline from live probe results only.
//
// History: F1-FIX-10-K / K2#13 removed canned per-state snapshots; E3 removed the
// remaining dependence on the provisioning ledger, which a hand-wired tenant never
// updates and which therefore kept reporting "still converging". Here:
//   * the shared plane is the app itself (this page was served by it) and the
//     module registry (the manifests are loaded in this process);
//   * every other row is a probe result from ./probes.server.ts, or it is absent.
// Nothing here guesses, and no text names a component the app cannot see.
import type { ProbedKey, ProbeStatus } from './probes.server'

export type RowStatus = ProbeStatus

export interface SystemService {
  key: 'app' | 'registry' | ProbedKey
  name: string
  plane: 'shared' | 'tenant'
  tech: string
  message: string
  status: RowStatus
}

export interface ProbedRow {
  key: ProbedKey
  status: ProbeStatus
}

export type HeadlineTone = 'success' | 'warn' | 'danger'

export interface SystemHeadline {
  label: string
  tone: HeadlineTone
  icon: string
  eyebrow: string
  headline: string
  sub: string
}

/** Pill per row status. The base `.pill` is neutral (`cls: ''`). */
export const ROW_PILL: Record<RowStatus, { cls: string; icon: string; label: string }> = {
  ok: { cls: 'pill-success', icon: 'check', label: 'Erreichbar' },
  unreachable: { cls: 'pill-danger', icon: 'alert-triangle', label: 'Nicht erreichbar' },
  off: { cls: '', icon: 'toggle-left', label: 'Aus' },
}

const SHARED: readonly SystemService[] = [
  {
    key: 'app',
    name: 'Anwendung',
    plane: 'shared',
    tech: 'SvelteKit',
    message: 'Diese Seite wurde von der Anwendung ausgeliefert.',
    status: 'ok',
  },
  {
    key: 'registry',
    name: 'Modul-Registry',
    plane: 'shared',
    tech: 'Modul-Manifeste',
    message: 'Die Manifeste der Module sind geladen.',
    status: 'ok',
  },
]

interface ProbedCopy {
  name: string
  tech: string
  ok: string
  off: string
  down: string
}

const PROBED: Record<ProbedKey, ProbedCopy> = {
  db: {
    name: 'PostgreSQL',
    tech: 'eigene Datenbank',
    ok: 'Die Datenbank dieses Mandanten antwortet.',
    off: '',
    down: 'Die Datenbank dieses Mandanten antwortet nicht.',
  },
  keycloak: {
    name: 'Keycloak-Realm',
    tech: 'Anmeldung und Rollen',
    ok: 'Der Realm dieses Mandanten antwortet.',
    off: '',
    down: 'Der Realm dieses Mandanten antwortet nicht. Neue Anmeldungen sind betroffen.',
  },
  nextcloud: {
    name: 'Nextcloud',
    tech: 'Dateien und Kalender',
    ok: 'Der Dateidienst antwortet.',
    off: 'Das Modul Dateien ist ausgeschaltet.',
    down: 'Der Dateidienst antwortet nicht. Dateien und Protokoll-Dokumente sind betroffen.',
  },
  matrix: {
    name: 'Matrix-Homeserver',
    tech: 'Synapse',
    ok: 'Der Chat-Server antwortet.',
    off: 'Das Modul Chat ist ausgeschaltet.',
    down: 'Der Chat-Server antwortet nicht. Chat ist betroffen.',
  },
}

export function systemServices(probed: readonly ProbedRow[]): SystemService[] {
  const tenantRows = probed.map((p): SystemService => {
    const d = PROBED[p.key]
    return {
      key: p.key,
      name: d.name,
      plane: 'tenant',
      tech: d.tech,
      message: p.status === 'ok' ? d.ok : p.status === 'off' ? d.off : d.down,
      status: p.status,
    }
  })
  // Without a resolved tenant there is nothing to probe; the shared rows alone
  // would read like a health claim for a customer that does not exist.
  return probed.length === 0 ? [] : [...SHARED, ...tenantRows]
}

/** The tally "n / m erreichbar": only rows that were probed and are not switched off.
 *  The shared rows are true by construction and would pad the count. */
export function countReachable(services: readonly SystemService[]): { ok: number; total: number } {
  const counted = services.filter((s) => s.plane === 'tenant' && s.status !== 'off')
  return { ok: counted.filter((s) => s.status === 'ok').length, total: counted.length }
}

/** The overall banner. A healthy claim needs a probe result for every listed service. */
export function systemHeadline(tenantActive: boolean, services: readonly SystemService[]): SystemHeadline {
  if (!tenantActive) {
    return {
      label: 'Unbekannt',
      tone: 'warn',
      icon: 'info',
      eyebrow: 'Kein Mandant',
      headline: 'Kein Mandant aufgelöst.',
      sub: 'Für diese Anfrage wurde kein Mandant gefunden, deshalb gibt es nichts zu prüfen.',
    }
  }
  const down = services.filter((s) => s.status === 'unreachable')
  const core = down.filter((s) => s.key === 'db' || s.key === 'keycloak')
  if (core.length > 0) {
    return {
      label: 'Fehler',
      tone: 'danger',
      icon: 'alert-triangle',
      eyebrow: 'Kerndienst nicht erreichbar',
      headline: 'Ein Kerndienst dieser Instanz antwortet nicht.',
      sub: `Betroffen: ${core.map((s) => s.name).join(', ')}. Anmeldung und Daten können gestört sein.`,
    }
  }
  if (down.length > 0) {
    return {
      label: 'Eingeschränkt',
      tone: 'warn',
      icon: 'alert-triangle',
      eyebrow: 'Dienst nicht erreichbar',
      headline: 'Ein Dienst dieser Instanz antwortet nicht.',
      sub: `Betroffen: ${down.map((s) => s.name).join(', ')}. Die übrigen Funktionen laufen weiter.`,
    }
  }
  return {
    label: 'In Ordnung',
    tone: 'success',
    icon: 'check',
    eyebrow: 'Alles erreichbar',
    headline: 'Alle geprüften Dienste sind erreichbar.',
    sub: 'Die Anwendung hat jeden Dienst beim Laden dieser Seite geprüft. Ausgeschaltete Module werden nicht geprüft.',
  }
}
