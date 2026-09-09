import type { GremionConfig } from './config'

export function generateLoeschkonzept(config: GremionConfig, asOf: Date = new Date()): string {
  const { retention, compliance } = config
  const dateStr = asOf.toISOString().slice(0, 10)

  return `# Löschkonzept — ${compliance.controller_name || 'StuRa'}
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
| Zugriffsprotokolle (pseudonymisiert, ipcrypt-nd) | **${retention.access_logs_days} Tage** | BayLDA-Empfehlung 30 Tage; Art. 5 Abs. 1 lit. e DSGVO |
| Anwendungs-/Fehlerprotokolle | **${retention.app_logs_days} Tage** | Art. 5 Abs. 1 lit. e, Art. 6 Abs. 1 lit. f DSGVO |
| Sicherheits-/Auditprotokolle (mit Personenbezug) | **${retention.security_logs_days} Tage** | BSI-Mindeststandard Protokollierung v2.1 (Nov. 2024) |
| Sicherheitsprotokolle (ohne Personenbezug) | **${retention.security_nopii_logs_days} Tage** | BSI-Mindeststandard Ausnahmeregelung |
| Datenbankbackups (allgemein) | 30 Tage lokal / 365 Tage Remote | Art. 32 DSGVO; TOMs |
| Finanzdaten-Backups (Finanzverwaltung) | 30 Tage lokal / 3650 Tage Remote | § 257 HGB; § 147 AO (10 Jahre) |

## 4. Technische Umsetzung der Löschung

- **IP-Adressen** werden vor der Speicherung mittels ipcrypt-nd (AES-128, draft-denis-ipcrypt-13) pseudonymisiert. Rohe IP-Adressen werden nicht persistiert.
- **Protokolldateien** werden durch Vector (Retention-Filter) und logrotate (Backstop) innerhalb der konfigurierten Fristen automatisch gelöscht.
- **Datenbankbackups** werden durch restic (lokales Repository, 30 Tage) und rclone (Remote-Speicher) mit automatischer Bereinigung verwaltet.
- **Schlüsselrotation** für ipcrypt erfolgt täglich; historische Schlüssel werden nach Ablauf der Zugriffsprotokoll-Frist gelöscht.

## 5. Änderungshistorie

Alle Änderungen an Löschfristen werden im Systemauditlog (Tabelle \`audit_log\`) mit Zeitstempel, Benutzer-ID, Feldname, Alt- und Neuwert protokolliert.

---
*Dieses Dokument wurde automatisch aus der aktuellen Systemkonfiguration generiert. Bei Fragen wenden Sie sich an ${compliance.dpo_email || 'den/die Datenschutzbeauftragte(n)'}.*
`
}
