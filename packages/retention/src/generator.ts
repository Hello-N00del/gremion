// packages/retention/src/generator.ts -- the generated Loeschkonzept (TRD-145,
// DIN EN ISO/IEC 27555:2025-09 structure [A: the standard text is unverified;
// the sections follow its published outline: scope, categories with deletion
// class and start event, periods, procedure, responsibilities]).
//
// Pure: registry in, German HTML out; no clock, no database. The caller passes
// the generation date and the version. It names KERNEL categories only; a
// module category appears when, and only when, the caller passes it (the
// enabled module's own retention profile), so a module that is OFF is absent
// from the document and the kernel categories are never touched by that.
// Backups are not listed: the pilot has none (no fixed backup rows).
import { CACHE_ROW, CACHE_TTL_HOURS, CEILING_DAYS, DB_PURGE_TICK_DAYS, dbWindowDays, enforcedDays, LOG_CLASSES, logClass, OPS_RUN_ROW } from './registry.ts'
import type { LogClass } from './registry.ts'

export interface ModuleCategory {
  /** Reader-facing module name (never an internal id). */
  moduleLabel: string
  category: string
  startTrigger: string
  periodDe: string
  basisDe: string
}

export interface LoeschkonzeptInput {
  version: string
  /** ISO date (YYYY-MM-DD) the document is generated for. */
  generatedOn: string
  moduleCategories?: readonly ModuleCategory[]
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function deDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new RangeError('generatedOn must be YYYY-MM-DD')
  return `${m[3]}.${m[2]}.${m[1]}`
}

function periodCell(c: LogClass): string {
  const e = c.sink === 'loki' ? enforcedDays(c) : c.regularDays
  const base = `regulär ${c.regularDays} Tage, Obergrenze ${c.capDays} Tage`
  if (c.id === 'trace') return `${base}; durchgesetzt ${e} Tage`
  return e < c.regularDays
    ? `${base}; durchgesetzt ${e} Tage, damit der ungünstigste Fall des Speichers unter der Obergrenze bleibt`
    : `${base}; durchgesetzt ${e} Tage`
}

function logRows(): string {
  return LOG_CLASSES.map(
    (c) =>
      `        <tr><td>${esc(c.labelDe)}</td><td>K5</td><td>Eintrag geschrieben</td><td>${esc(periodCell(c))}</td><td>${esc(c.purposeDe)}</td><td>${esc(c.basisDe)}</td></tr>`,
  ).join('\n')
}

function moduleRows(mods: readonly ModuleCategory[]): string {
  return mods
    .map(
      (m) =>
        `        <tr><td>${esc(m.category)} (${esc(m.moduleLabel)})</td><td>${esc(m.startTrigger)}</td><td>${esc(m.periodDe)}</td><td>${esc(m.basisDe)}</td></tr>`,
    )
    .join('\n')
}

export function generateLoeschkonzept(input: LoeschkonzeptInput): string {
  const app = logClass('application')
  const mods = input.moduleCategories ?? []
  // plt.job_run follows the application-log class (RC-OPS-RUN); a database table is bounded by
  // min(regular, cap - 1 tick), not by Loki's overhead.
  const appDb = dbWindowDays(app)
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Löschkonzept (Protokolle und Betriebsdaten)</title>
</head>
<body>
<h1>Löschkonzept (Protokolle und Betriebsdaten)</h1>
<p>Version ${esc(input.version)}, erzeugt am ${esc(deDate(input.generatedOn))}. Dieses Dokument wird aus der Löschfrist-Registrierung des Systems erzeugt und bei jeder Änderung einer Frist oder des Modulbestands neu erzeugt (Art. 5 Abs. 2, Art. 30 DSGVO; Aufbau nach DIN EN ISO/IEC 27555).</p>

<h2>1. Zweck und Geltungsbereich</h2>
<p>Das Konzept legt fest, wann welche Protokolle und Betriebsdaten gelöscht werden. Es gilt für die Protokollklassen des Kerns und für die Module, die für dieses Gremium eingeschaltet sind. Kein Protokoll wird länger als ${CEILING_DAYS} Tage aufbewahrt; das ist die Betreiberentscheidung vom 30.09.2026 und gilt unabhängig von jeder Einstellung durch Gremienverwaltende.</p>

<h2>2. Löschklassen und Fristen der Protokolle</h2>
<table>
    <thead>
        <tr><th>Kategorie</th><th>Löschklasse</th><th>Startereignis</th><th>Frist</th><th>Zweck</th><th>Rechtsgrundlage</th></tr>
    </thead>
    <tbody>
${logRows()}
    </tbody>
</table>
<p>Anwendungsprotokolle: regulär ${app.regularDays} Tage, durchgesetzt ${enforcedDays(app)} Tage. Der Protokollspeicher löscht nicht auf die Minute genau, sondern erst nach seinem Indexzeitraum, einer Löschverzögerung und dem nächsten Verdichtungslauf; die durchgesetzte Frist ist deshalb so gewählt, dass der ungünstigste Fall die Obergrenze von ${CEILING_DAYS} Tagen nicht überschreitet.</p>

<h2>3. Weitere Kategorien des Kerns</h2>
<table>
    <thead>
        <tr><th>Kategorie</th><th>Startereignis</th><th>Frist</th><th>Katalogzeile</th></tr>
    </thead>
    <tbody>
        <tr><td>Audit-Tabelle der Anwendung (Datenbank, hash-verkettet)</td><td>Eintrag geschrieben</td><td>Nachweis der Verwaltungshandlungen des Gremiums (Governance-Datensatz): wird von keinem Zeitgeber gelöscht; die Anwendung darf Einträge nur anhängen, nicht ändern oder löschen; eine Löschung einzelner Personenbezüge erfolgt durch Schwärzung, nicht durch Löschen der Kette</td><td>RC-GOV-CHAIN</td></tr>
        <tr><td>Läufe geplanter Aufgaben und Bereitstellungsschritte</td><td>Lauf beendet</td><td>${appDb} Tage, täglich gelöscht (ungünstigster Fall ${appDb + DB_PURGE_TICK_DAYS} Tage)</td><td>${OPS_RUN_ROW}</td></tr>
        <tr><td>Zwischenspeicher mit personenbezogenen Daten</td><td>Eintrag geschrieben</td><td>höchstens ${CACHE_TTL_HOURS} Stunde; sofort bei einem Löschverlangen der genannten Person</td><td>${CACHE_ROW}</td></tr>
    </tbody>
</table>
${
  mods.length > 0
    ? `
<h2>4. Kategorien eingeschalteter Module</h2>
<table>
    <thead>
        <tr><th>Kategorie</th><th>Startereignis</th><th>Frist</th><th>Rechtsgrundlage</th></tr>
    </thead>
    <tbody>
${moduleRows(mods)}
    </tbody>
</table>
`
    : `
<h2>4. Kategorien eingeschalteter Module</h2>
<p>Für dieses Gremium ist kein Modul mit eigenen Löschkategorien eingeschaltet. Schaltet das Gremium ein Modul ein, wird dieses Konzept neu erzeugt und führt dessen Kategorien auf.</p>
`
}
<h2>5. Verfahren</h2>
<p>Ein täglich ausgeführter Löschlauf (der Zeitgeber gremion-purge.timer des Betriebsrechners, Aufruf purge-run) entfernt abgelaufene Einträge, schreibt sein Ergebnis als Lauf-Nachweis und ist beliebig wiederholbar. Die Löschfristen der Protokollspeicher sind in deren Konfiguration festgelegt, nicht in einer Einstellung der Anwendung. Die Audit-Tabelle ist davon ausgenommen (Abschnitt 3). Sicherungen sind im Pilotbetrieb nicht vorhanden und deshalb nicht aufgeführt.</p>

<h2>6. Verantwortlichkeiten</h2>
<p>Die Betreiberin oder der Betreiber verantwortet Löschlauf und Speicherkonfiguration; das Gremium verantwortet die Auswahl der eingeschalteten Module. Änderungen an Fristen erfolgen nur über die Löschfrist-Registrierung und werden in diesem Dokument versioniert.</p>
</body>
</html>
`
}
