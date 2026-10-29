import type { GremionConfig } from './config'
import { AUDIT_LOG_RECORD_DE, OPERATOR_DECISION_DE, RETENTION_CAVEATS, RETENTION_DEFAULTS, type RetentionField } from '$lib/retention-tiers'

export function generateLoeschkonzept(config: GremionConfig, asOf: Date = new Date()): string {
  const { compliance } = config
  // The windows are fixed in the product (retention-tiers.ts, tied to the packages/retention registry
  // that renders the log store's retention). The stored config.retention.* is NOT read: nothing
  // enforces it, and a value saved before the windows were fixed would be printed as a deletion
  // period not applied. The audit table is a governance record (RC-GOV-CHAIN): no period for it.
  const retention = RETENTION_DEFAULTS
  const dateStr = asOf.toISOString().slice(0, 10)
  // A tier no purge consumer enforces is stated as configuration, not as a deletion window.
  const caveat = (field: RetentionField): string => {
    const text = RETENTION_CAVEATS[field]
    return text === null ? '' : ` — **Hinweis:** ${text}`
  }

  return `# Löschkonzept — ${compliance.controller_name || 'Organisation'}
*Stand: ${dateStr} | Automatisch generiert aus aktueller Systemkonfiguration*

## 1. Verantwortliche Stelle

**Bezeichnung:** ${compliance.controller_name || '(nicht konfiguriert)'}
**Anschrift:** ${compliance.controller_address || '(nicht konfiguriert)'}
**Datenschutzbeauftragte(r):** ${compliance.dpo_name || '(nicht konfiguriert)'} — ${compliance.dpo_email || ''}

## 2. Zweck der Verarbeitung

${compliance.purpose_description || 'Betrieb einer selbst gehosteten Plattform für studentische Verwaltung.'}

**Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO (berechtigte Interessen — IT-Sicherheit gemäß Erwägungsgrund 49) in Verbindung mit Art. 6 Abs. 1 lit. e DSGVO (öffentliche Aufgabe der verfassten Studierendenschaft).

## 3. Löschfristen nach Datenkategorie

| Datenkategorie | Standardwert | Gesetzliche Grundlage |
|---|---|---|
| Zugriffsprotokolle (pseudonymisiert, ipcrypt-nd) | **${retention.access_logs_days} Tage** | Betreiber-Obergrenze 30 Tage für jede Protokollklasse (${OPERATOR_DECISION_DE}); Art. 5 Abs. 1 lit. e DSGVO${caveat('access_logs_days')} |
| Anwendungs-/Fehlerprotokolle | **${retention.app_logs_days} Tage** | Betreiber-Obergrenze 30 Tage (${OPERATOR_DECISION_DE}); Art. 5 Abs. 1 lit. e, Art. 6 Abs. 1 lit. f DSGVO${caveat('app_logs_days')} |
| Sicherheitsprotokolle (mit Personenbezug) | **${retention.security_logs_days} Tage** | Betreiber-Obergrenze 30 Tage (${OPERATOR_DECISION_DE}); Art. 5 Abs. 1 lit. e DSGVO${caveat('security_logs_days')} |
| Sicherheitsprotokolle (ohne Personenbezug) | **${retention.security_nopii_logs_days} Tage** | Betreiber-Obergrenze 30 Tage (${OPERATOR_DECISION_DE})${caveat('security_nopii_logs_days')} |
| Audit-Tabelle der Anwendung (Datenbank, hash-verkettet) | wird von keinem Zeitgeber gelöscht | ${AUDIT_LOG_RECORD_DE} Art. 5 Abs. 1 lit. e und Abs. 2 DSGVO |
| Datenbankbackups (allgemein) | 30 Tage lokal / 365 Tage Remote | Art. 32 DSGVO; TOMs |
| Finanzdaten-Backups (Finanzverwaltung) | 30 Tage lokal / 3650 Tage Remote | § 257 HGB; § 147 AO (10 Jahre) |

## 4. Technische Umsetzung der Löschung

- **IP-Adressen** werden vor der Speicherung mittels ipcrypt-nd (AES-128, draft-denis-ipcrypt-13) pseudonymisiert. Rohe IP-Adressen werden nicht persistiert.
- **Protokolldateien** der Infrastruktur (Traefik/Vector) werden durch Vector (Retention-Filter) und logrotate (Backstop) automatisch gelöscht, höchstens nach 30 Tagen. Die Fristen für Zugriffs-, Anwendungs- und Sicherheitsprotokolle werden nicht von der Anwendung durchgesetzt, sondern von der Konfiguration des Protokollspeichers (siehe Hinweise in der Tabelle). Die Audit-Tabelle der Anwendung (RC-GOV-CHAIN) wird von keinem Zeitgeber gelöscht; die Anwendung darf sie nur ergänzen. Die tägliche Löschung des Betriebs (Host-Job, nicht die Anwendung selbst) betrifft Läufe geplanter Aufgaben und technische Zwischendaten und protokolliert ihr Ergebnis je Lauf.
- **Datenbankbackups** werden durch restic (lokales Repository, 30 Tage) und rclone (Remote-Speicher) mit automatischer Bereinigung verwaltet.
- **Schlüsselrotation** für ipcrypt erfolgt täglich; historische Schlüssel werden nach Ablauf der Zugriffsprotokoll-Frist gelöscht.

## 5. Änderungshistorie

Die Löschfristen sind fest vorgegeben und können im laufenden Betrieb nicht geändert werden; eine Änderung erfolgt nur mit einer neuen Programmversion. Die tägliche Löschung wird mit einem Ergebnisdatensatz protokolliert.

---
*Dieses Dokument wurde automatisch aus der aktuellen Systemkonfiguration generiert. Bei Fragen wenden Sie sich an ${compliance.dpo_email || 'den/die Datenschutzbeauftragte(n)'}.*
`
}
