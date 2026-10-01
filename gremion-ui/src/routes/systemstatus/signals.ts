// F1-FIX-10-K / K2#13: Systemstatus health rows from REAL signals only.
//
// The old page rendered `instanceServices()`, which falls back to a canned
// per-state snapshot for every service without a ledger row, so a hand-bound
// tenant (no tenant_provisioning_resource rows) showed six green "Bereit" rows
// that nothing had measured. Here:
//   * shared plane: `app` is ok because this page was served by it; `registry`
//     is ok because the module manifests are loaded in this process.
//   * silo plane: the status of a service is the ledger row's status, or
//     'unknown' when there is no row. Never a guess.
import {
  INSTANCE_STATE_META,
  SERVICES,
  SERVICE_MESSAGES,
  type InstanceService,
  type InstanceState,
  type InstanceStateMeta,
  type ServiceStatus,
} from '$lib/instance-status'

export type SignalStatus = ServiceStatus | 'unknown'

export interface SignalService extends InstanceService {
  status: SignalStatus
  message: string
}

export const UNKNOWN_PILL = { cls: '', icon: 'info', label: 'Unbekannt' } as const

export function systemServices(
  state: InstanceState,
  realStatuses: Partial<Record<string, ServiceStatus>> | undefined,
): SignalService[] {
  const msgs = SERVICE_MESSAGES[state] ?? {}
  return SERVICES.map((s) => {
    if (s.plane === 'shared') return { ...s, status: 'ok' as const, message: s.detail }
    const real = realStatuses?.[s.key]
    if (!real) {
      return { ...s, status: 'unknown' as const, message: 'Kein Statussignal vorhanden.' }
    }
    return { ...s, status: real, message: real === 'ok' ? s.detail : (msgs[s.key] ?? s.detail) }
  })
}

/** The overall banner: a "ready" claim needs a real signal for every service. */
export function systemHeadline(state: InstanceState, services: readonly SignalService[]): InstanceStateMeta {
  const unknown = services.filter((s) => s.status === 'unknown')
  if (state === 'ready' && unknown.length > 0) {
    return {
      label: 'Unbekannt',
      tone: 'warn',
      icon: 'info',
      eyebrow: 'Kein vollständiges Signal',
      headline: 'Für diese Instanz liegt kein vollständiges Statussignal vor.',
      sub:
        'Die Bereitstellungs-Aufzeichnung fehlt ganz oder teilweise, zum Beispiel bei einem von Hand angelegten Mandanten. ' +
        'Dienste ohne Signal werden als unbekannt gezeigt, nicht als bereit.',
    }
  }
  return INSTANCE_STATE_META[state] ?? INSTANCE_STATE_META.ready
}
