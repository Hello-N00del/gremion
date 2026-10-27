// What the customer page says about the NEWEST provisioning request (shared by
// server and client). The states are the executor's (plt.provisioning_request
// .state: queued, running, succeeded, failed, refused, expired, dead); the page
// splits `running` in two: "verifying" until the executor has stamped
// evidence_verified_at (mark_provisioning_request_verified), then "running"
// with the step of the newest plt.provisioning_request_event.
//
// The failure "reason code" is derived from `outcome`, which the executor
// writes as free text (infra/host/bin/gremion-executor, run_request):
//   "verify: ..."                    -> verify_failed
//   "<kind> <slug>: failed in <step> (exit N); ..." -> step_failed:<step>
//   "refused: <reason>"              -> refused (the reason is the text)

export const STEP_LABEL: Record<string, string> = {
  realm_created: 'Anmelde-Realm angelegt',
  database_created: 'Kerndatenbank angelegt und migriert',
  domain_bound: 'Host gebunden (DNS geprüft)',
  storage_prefix_reserved: 'Speicherbereich reserviert',
  first_body_created: 'Erstes Gremium angelegt',
  broker_account_created: 'Broker-Konto angelegt',
  mail_principal_issued: 'Eigener Mail-Absender ausgestellt',
  first_accounts_created: 'Erste Verwaltungskonten eingeladen',
}

export interface RequestStateInput {
  state: string
  evidenceVerifiedAt: string | null
  outcome: string | null
  lastStep: string | null
}

export type RequestPhase = 'queued' | 'verifying' | 'running' | 'succeeded' | 'failed' | 'refused' | 'expired' | 'dead'

export interface RequestDescription {
  phase: RequestPhase
  label: string
  /** The sentence under the label, German. */
  text: string
  /** While true the page reloads itself (meta refresh). */
  active: boolean
  /** A new request may be offered (failed or refused only). */
  retryable: boolean
  /** The current step (running only). */
  step: string | null
  /** The failure's reason code (failed/refused only). */
  code: string | null
}

const stepName = (s: string): string => STEP_LABEL[s] ?? s

export function describeRequest(r: RequestStateInput): RequestDescription {
  const d = (phase: RequestPhase, label: string, text: string, extra: Partial<RequestDescription> = {}): RequestDescription => ({
    phase,
    label,
    text,
    active: false,
    retryable: false,
    step: null,
    code: null,
    ...extra,
  })
  switch (r.state) {
    case 'queued':
      return d('queued', 'In der Warteschlange', 'Die Anfrage wartet darauf, dass der Ausführer sie übernimmt.', { active: true })
    case 'running':
      if (r.evidenceVerifiedAt === null) return d('verifying', 'Wird geprüft', 'Der Ausführer prüft die Anfrage und den Anmeldenachweis; noch läuft nichts.', { active: true })
      return d('running', 'Läuft', r.lastStep ? `Aktueller Schritt: ${stepName(r.lastStep)}.` : 'Die Einrichtung läuft.', { active: true, step: r.lastStep })
    case 'succeeded':
      return d('succeeded', 'Erledigt', 'Die Anfrage wurde ausgeführt.')
    case 'failed': {
      const o = r.outcome ?? ''
      if (o.startsWith('verify:')) {
        return d('failed', 'Fehlgeschlagen', 'Die Prüfung der Anfrage konnte nicht abgeschlossen werden; es wurde nichts ausgeführt.', { retryable: true, code: 'verify_failed' })
      }
      const m = /failed in ([a-z][a-z0-9_-]*)(?: \(exit (\d+)\))?/.exec(o)
      if (m) {
        const exit = m[2] ? ` (Exit ${m[2]})` : ''
        return d('failed', 'Fehlgeschlagen', `Der Schritt „${stepName(m[1]!)}“ ist fehlgeschlagen${exit}. Eine neue Anfrage setzt am bisherigen Stand fort.`, {
          retryable: true,
          code: `step_failed:${m[1]}`,
          step: m[1]!,
        })
      }
      return d('failed', 'Fehlgeschlagen', 'Die Einrichtung ist fehlgeschlagen. Die Ursache steht im Log des Ausführers.', { retryable: true, code: 'failed' })
    }
    case 'refused': {
      const reason = (r.outcome ?? '').replace(/^refused:\s*/, '').trim()
      return d('refused', 'Abgelehnt', `Die Anfrage wurde abgelehnt: ${reason === '' ? 'ohne Angabe eines Grundes' : reason}`, { retryable: true, code: 'refused' })
    }
    case 'expired':
      return d('expired', 'Verfallen', 'Der Ausführer hat die Anfrage nicht rechtzeitig übernommen (30 Minuten). Bitte im Formular neu anfordern.')
    case 'dead':
      return d('dead', 'Abgebrochen', 'Der Ausführer ist während der Einrichtung ausgefallen; die Anfrage wird nicht wiederholt.')
    default:
      return d('failed', r.state, `Unbekannter Zustand „${r.state}“.`, { code: 'unknown_state' })
  }
}
