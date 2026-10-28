// packages/retention/src/registry.ts -- the six log deletion classes, the ONE
// place the figures live for the log stores (TASK-033-a, TRD-143, TRD-191).
//
// Source of truth for the numbers is docs/compliance/retention-catalogue.md
// section 4.1 (TASK-070); registry.test.ts parses that table and fails when a
// row drifts from this file. Do not edit the catalogue from here.
//
// Three figures per class:
//   regular  what the catalogue derives as the period the purpose needs;
//   cap      the hard ceiling [D R29-I6]: no class outlives 30 days (trace 14);
//   enforced what the stores are configured to, so the store's WORST CASE
//            (window + the store's own delay) stays under the cap:
//              loki   window + 24 h index period + 2 h delete delay + 10 min
//                     compaction interval  -> floor((cap - 1 d 2 h 10 min));
//              db     min(regular, cap - one daily purge tick) -- dbWindowDays;
//                     a database table is NOT run through Loki's overhead.
//            application is regular 30 / cap 30, so it is ENFORCED at 28 days
//            in Loki (and 29 in the one database table that follows it,
//            plt.job_run): the generated Loeschkonzept states the figures.
// The kernel's hash-chained audit_log table is NOT a class here. It is a
// governance record (RC-GOV-CHAIN): no timer purges it (operator decision
// 2026-10-28). The `audit` class below is the Loki stream of operator and
// vendor access logs (RC-LOG-AUD); only the stores it names are bounded.
// This file names kernel streams only. No module id appears here or in any
// retention surface (module-off.test.ts): a module's logs reach Loki through
// the generic OTLP / spool path with a class label, so a module that is OFF
// removes a source, never a stream.

export type LogClassId = 'access' | 'security' | 'finance' | 'audit' | 'application' | 'trace'
export type LogSink = 'loki' | 'tempo'

export interface LogClass {
  id: LogClassId
  /** The catalogue row (docs/compliance/retention-catalogue.md section 4.1). */
  row: string
  /** Stable profile id in ops.retention_profile (rp-<ctx>-<name>). */
  profileId: string
  labelDe: string
  purposeDe: string
  basisDe: string
  regularDays: number
  capDays: number
  sink: LogSink
}

/** Operator ceiling [D R29-I6]. */
export const CEILING_DAYS = 30

/** Loki's own delay on top of a window, in minutes (loki.yaml: 24 h period, 2 h delay, 10 min compaction). */
export const LOKI_INDEX_PERIOD_MIN = 24 * 60
export const LOKI_DELETE_DELAY_MIN = 2 * 60
export const LOKI_COMPACTION_MIN = 10
export const LOKI_OVERHEAD_MIN = LOKI_INDEX_PERIOD_MIN + LOKI_DELETE_DELAY_MIN + LOKI_COMPACTION_MIN

/** The purge runs daily, so a row can outlive its window by this many days. */
export const DB_PURGE_TICK_DAYS = 1

/** In the order Loki's retention_stream renders them (the order of today's file). */
export const LOG_CLASSES: readonly LogClass[] = [
  {
    id: 'access', row: 'RC-LOG-ACC', profileId: 'rp-ops-log-access', labelDe: 'Zugriffsprotokolle',
    purposeDe: 'Missbrauchs- und Ratenbegrenzungserkennung, kurzfristige Angriffsforensik auf pseudonymisierten Adressen',
    basisDe: 'Art. 5 Abs. 1 lit. e und c, Art. 32 Abs. 1 DSGVO; keine gesetzliche Pflicht',
    regularDays: 14, capDays: 30, sink: 'loki',
  },
  {
    id: 'security', row: 'RC-LOG-SEC', profileId: 'rp-ops-log-security', labelDe: 'Sicherheitsprotokolle',
    purposeDe: 'Erkennung von Angriffen mit Verweildauer über einen Monat, Rekonstruktion von Vorfällen (einschliesslich Anmelde- und Verwaltungsereignisse des Identitätsanbieters)',
    basisDe: 'Art. 5 Abs. 1 lit. e, Art. 32 Abs. 1 lit. d, Art. 33 Abs. 5 DSGVO',
    regularDays: 27, capDays: 30, sink: 'loki',
  },
  {
    id: 'finance', row: 'RC-LOG-FIN', profileId: 'rp-ops-log-finance', labelDe: 'Finanzprotokolle',
    purposeDe: 'Missbrauchserkennung und Vorfallsrekonstruktion bei Finanzvorgängen; wer freigegeben und gezahlt hat, steht in den Finanzunterlagen selbst',
    basisDe: 'Art. 5 Abs. 1 lit. e DSGVO; die Aufbewahrungspflichten betreffen die Finanzunterlagen, nicht die Protokollzeilen',
    regularDays: 27, capDays: 30, sink: 'loki',
  },
  {
    id: 'audit', row: 'RC-LOG-AUD', profileId: 'rp-ops-log-audit', labelDe: 'Audit- und Betreiberzugriffsprotokolle',
    purposeDe: 'Nachweis von Betreiber- und Anbieterzugriffen auf Daten des Gremiums; nie kürzer als das Sicherheitsfenster',
    basisDe: 'Art. 5 Abs. 1 lit. e und Abs. 2, Art. 28 Abs. 3 lit. h DSGVO',
    regularDays: 27, capDays: 30, sink: 'loki',
  },
  {
    id: 'application', row: 'RC-LOG-APP', profileId: 'rp-ops-log-application', labelDe: 'Anwendungsprotokolle',
    purposeDe: 'Fehlerdiagnose über einen Monatszyklus aus Release und Review',
    basisDe: 'Art. 5 Abs. 1 lit. e, Art. 6 Abs. 1 lit. e oder f DSGVO; keine gesetzliche Pflicht',
    regularDays: 30, capDays: 30, sink: 'loki',
  },
  {
    id: 'trace', row: 'RC-LOG-TRC', profileId: 'rp-ops-log-trace', labelDe: 'Trace-Speicher',
    purposeDe: 'Latenz- und Fehleranalyse einzelner Anfragen; Span-Attribute können Nutzerkennungen tragen',
    basisDe: 'Art. 5 Abs. 1 lit. e und c DSGVO; keine gesetzliche Pflicht',
    regularDays: 7, capDays: 14, sink: 'tempo',
  },
] as const

export function logClass(id: LogClassId): LogClass {
  const c = LOG_CLASSES.find((x) => x.id === id)
  if (!c) throw new RangeError(`unknown log class ${String(id)}`)
  return c
}

/** Loki's worst case for a window, in minutes: window + index period + delete delay + compaction interval. */
export function lokiWorstCaseMinutes(windowDays: number): number {
  return windowDays * 1440 + LOKI_OVERHEAD_MIN
}

/** The largest whole-day Loki window whose worst case stays at or under `capDays`. */
export function maxLokiWindowDays(capDays: number): number {
  return Math.floor((capDays * 1440 - LOKI_OVERHEAD_MIN) / 1440)
}

/**
 * The window a store is configured to. Loki: min(regular, the largest window
 * whose worst case fits the cap). Tempo (TASK-116's store): min(regular, cap).
 */
export function enforcedDays(c: LogClass): number {
  const room = c.sink === 'loki' ? maxLokiWindowDays(c.capDays) : c.capDays
  return Math.min(c.regularDays, room)
}

/**
 * The window a DATABASE table purges at (plt.job_run follows RC-LOG-APP): the
 * catalogue's regular window, and never more than the cap minus one daily
 * purge tick. Loki's own overhead does not apply to a table (a run on 29 d of
 * job_run is 30 d at worst).
 */
export function dbWindowDays(c: LogClass): number {
  return Math.min(c.regularDays, c.capDays - DB_PURGE_TICK_DAYS)
}

export function lokiClasses(): LogClass[] {
  return LOG_CLASSES.filter((c) => c.sink === 'loki')
}

/** "15 d 2 h 10 min" -- the form loki.yaml's header table uses. */
export function formatDuration(totalMinutes: number): string {
  const d = Math.floor(totalMinutes / 1440)
  const h = Math.floor((totalMinutes % 1440) / 60)
  const m = totalMinutes % 60
  return [d ? `${d} d` : '', h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ')
}

/** RC-K1-CACHE: the application cache TTL for personal data, enforced in the cache configuration. */
export const CACHE_TTL_HOURS = 1
export const CACHE_ROW = 'RC-K1-CACHE'

/** RC-OPS-RUN: provisioning steps and job runs follow the application-log window. */
export const OPS_RUN_ROW = 'RC-OPS-RUN'
