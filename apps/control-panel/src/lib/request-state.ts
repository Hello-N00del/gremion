// What the customer page says about the NEWEST provisioning request (shared by
// server and client). The states are the executor's (plt.provisioning_request
// .state: queued, running, succeeded, failed, refused, expired, dead); the page
// splits `running` in two: "verifying" until the executor has stamped
// evidence_verified_at (mark_provisioning_request_verified), then "running"
// with the step of the newest plt.provisioning_request_event of this claim.
//
// The failure "reason code" is derived from `outcome`, which the executor
// writes as free text (infra/host/bin/gremion-executor, run_request):
//   "verify: ..."                                  -> verify_failed
//   "<kind> <slug>: failed in <step> (exit N); ..." -> step_failed:<step>
//   "refused: evidence: ..." / "refused: a panel request without its signed
//     evidence"                                    -> refused_evidence
//   "refused: <other reason>"                      -> refused
//   "no handler for <kind>"                        -> no_handler

/** The eight ledger kinds (plt.provisioning_step) in words: the customer's setup list. */
export const LEDGER_STEP_LABEL: Record<string, string> = {
  realm_created: 'Anmelde-Realm angelegt',
  database_created: 'Kerndatenbank angelegt und migriert',
  domain_bound: 'Host gebunden (DNS geprüft)',
  storage_prefix_reserved: 'Speicherbereich reserviert',
  first_body_created: 'Erstes Gremium angelegt',
  broker_account_created: 'Broker-Konto angelegt',
  mail_principal_issued: 'Eigener Mail-Absender ausgestellt',
  first_accounts_created: 'Erste Verwaltungskonten eingeladen',
}

/**
 * The EXECUTOR's step names (plt.provisioning_request_event.step and the
 * "failed in <step>" outcome): claim, verify, dispatch, the kind itself until
 * a marker, then the markers phase-a, mail, record-step, phase-b, router,
 * activate.
 */
export const EXECUTOR_STEP_LABEL: Record<string, string> = {
  claim: 'Anfrage übernommen',
  verify: 'Anfrage und Anmeldenachweis geprüft',
  dispatch: 'Bearbeiter gewählt',
  create: 'Einrichtung gestartet',
  suspend: 'Sperren (Anmeldung, Broker, Mail-Absender)',
  resume: 'Fortsetzen (Mail-Absender, Anmeldung, Broker)',
  'phase-a': 'Phase A (Realm, Kerndatenbank, Host)',
  mail: 'Mail-Absender',
  'record-step': 'Fortschritt im Ledger vermerkt',
  'phase-b': 'Phase B (Gremium, Konten)',
  router: 'Router-Konfiguration',
  activate: 'Freischaltung',
}

export interface RequestStateInput {
  kind: string
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
  /** The executor's own (English) reason, shown as "Begründung (technisch)". */
  detail: string | null
  /** While true the page reloads itself (meta refresh). */
  active: boolean
  /** A new request may be offered. */
  retryable: boolean
  /** Why no retry is offered, when the request ended and none is. */
  retryNote: string | null
  /** The current or failing step. */
  step: string | null
  /** The failure's reason code. */
  code: string | null
}

/** A step name in words; an unknown one is shown raw (it is plain text in the page, never markup). */
const stepName = (s: string): string => EXECUTOR_STEP_LABEL[s] ?? s
const STEP_TOKEN = /^[a-z][a-z0-9_-]{0,39}$/

const NOT_REPLAYABLE = 'Nur eine Einrichtung („create“) lässt sich hier wiederholen.'
const REDO_ACTION = 'Die Aktion „Mandant sperren“ bzw. „Mandant fortsetzen“ kann unten erneut ausgelöst werden; die Daten wurden nicht angetastet.'
const FIX_FORM = 'Die Angaben der Anfrage selbst wurden abgelehnt. Bitte im Formular „Neuer Mandant“ korrigiert neu anfordern.'

export function describeRequest(r: RequestStateInput): RequestDescription {
  const isCreate = r.kind === 'create'
  const d = (phase: RequestPhase, label: string, text: string, extra: Partial<RequestDescription> = {}): RequestDescription => ({
    phase,
    label,
    text,
    detail: null,
    active: false,
    retryable: false,
    retryNote: null,
    step: null,
    code: null,
    ...extra,
  })
  /** Retryable when the kind is create; otherwise says why not. */
  const retry = (): Partial<RequestDescription> => (isCreate ? { retryable: true } : { retryNote: r.kind === 'suspend' || r.kind === 'resume' ? REDO_ACTION : NOT_REPLAYABLE })
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
        return d('failed', 'Fehlgeschlagen', 'Die Prüfung der Anfrage konnte nicht abgeschlossen werden; es wurde nichts ausgeführt.', { ...retry(), code: 'verify_failed', detail: o })
      }
      const m = /failed in (\S+?)(?: \(exit (\d+)\))?(?:;|$)/.exec(o)
      if (m && STEP_TOKEN.test(m[1]!)) {
        const exit = m[2] ? ` (Exit ${m[2]})` : ''
        return d('failed', 'Fehlgeschlagen', `Der Schritt „${stepName(m[1]!)}“ ist fehlgeschlagen${exit}. Eine neue Anfrage setzt am bisherigen Stand fort.`, {
          ...retry(),
          code: `step_failed:${m[1]}`,
          step: m[1]!,
        })
      }
      return d('failed', 'Fehlgeschlagen', 'Die Einrichtung ist fehlgeschlagen. Die Ursache steht im Log des Ausführers.', { ...retry(), code: 'failed' })
    }
    case 'refused': {
      const o = r.outcome ?? ''
      if (o.startsWith('no handler for ')) return d('refused', 'Abgelehnt', 'Für diese Art von Anfrage gibt es noch keinen Bearbeiter.', { code: 'no_handler', detail: o, retryNote: FIX_FORM })
      const reason = o.replace(/^refused:\s*/, '').trim()
      const detail = reason === '' ? null : reason
      // the sign-in evidence (request-verify "evidence: ..." and a missing token): a fresh sign-in can fix it
      if (reason.startsWith('evidence: ') || reason.startsWith('a panel request without its signed evidence')) {
        return d('refused', 'Abgelehnt', 'Der Anmeldenachweis wurde nicht akzeptiert. Mit einer frischen Anmeldung kann die Anfrage erneut gestellt werden.', { ...retry(), code: 'refused_evidence', detail })
      }
      return d('refused', 'Abgelehnt', 'Die Anfrage wurde bei der Prüfung abgelehnt.', { code: 'refused', detail, retryNote: FIX_FORM })
    }
    case 'expired':
      return d('expired', 'Verfallen', 'Der Ausführer hat die Anfrage nicht rechtzeitig übernommen (30 Minuten).', retry())
    case 'dead':
      return d('dead', 'Abgebrochen', 'Der Ausführer ist während der Einrichtung ausgefallen (Lease verloren).', retry())
    default:
      return d('failed', r.state, `Unbekannter Zustand „${r.state}“.`, { code: 'unknown_state' })
  }
}
