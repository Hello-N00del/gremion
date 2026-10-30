<!-- i18n-sync: source=compliance.md sha256=7ce8bd9e0ccab4fcec73c626d423c6bc5ae14825457fcb3a3c2cb575c3fe8b71 -->
[English](./compliance.md) | **Deutsch**

# Compliance: Aufbewahrung, Löschung und Crypto-Shredding-Vertrag für Mandanten

Maßgebliche Quelle dafür, wie der Gremion-Governance-Kernel **Art. 5 Abs. 1 lit. e DSGVO**
(Speicherbegrenzung: personenbezogene Daten werden nicht länger als nötig aufbewahrt) einhält
und wie die gesamten personenbezogenen Daten eines Mandanten beim Löschen vernichtet werden.
Wird dem Konfigurationsobjekt eines Mandanten ein Aufbewahrungsfeld hinzugefügt oder ein
Purge- bzw. Shred-Schritt verschoben, ändert sich diese Datei mit.

Zu Vision, Architektur, Lizenzierung und zur Governance-Charta des Projekts siehe
[`docs/about-gremion.md`](./about-gremion.de.md). Dieses Dokument ist die operative
Compliance-Ebene; es wiederholt die Architektur nicht.

Die Admin-Shell-App heißt `gremion-ui`, die unten genannten Code-Pfade liegen daher unter
`gremion-ui/`. Der Kernel liefert genau zwei nicht abschaltbare Modul-Manifeste mit, `core`
und `governance`. Die hier beschriebenen Verträge zu Aufbewahrung und Shredding decken
deshalb Identität und Authentifizierung, Mandantenfähigkeit und die Governance-Domäne ab
(Gremien, Mitglieder, Organisationsbaum, Protokolle, Beschlüsse, das öffentliche Portal).
Feature-Module (elections, newsletter, calendar, files, messages, board, users, finance,
content, vault, handover) sind eigene Services hinter einer stabilen API, jeweils in einem
eigenen Repository; jedes Modul verantwortet und dokumentiert seine Aufbewahrung selbst.

Querverweise:
- Aufbewahrung von Logs auf Infrastrukturebene (Reverse-Proxy, Keycloak, Container-stdout):
  [`docs/log-retention-policy.md`](./log-retention-policy.de.md).
- Automatisch erzeugtes deutschsprachiges Löschkonzept (mandantenspezifische Angaben zur
  bzw. zum Verantwortlichen und zur bzw. zum Datenschutzbeauftragten; die Löschfristen selbst sind die
  festen Fenster des Produkts; wird betroffenen Personen bereitgestellt):
  [`gremion-ui/src/lib/server/loeschkonzept.ts`](../gremion-ui/src/lib/server/loeschkonzept.ts).

---

## 1. Art. 5 Abs. 1 lit. e DSGVO: Grundsätze der Aufbewahrung

Art. 5 Abs. 1 lit. e DSGVO verlangt, personenbezogene Daten nur so lange in einer Form zu
speichern, die die Identifizierung der betroffenen Personen ermöglicht, wie es für die
Zwecke der Verarbeitung erforderlich ist. Im Kernel wird diese Pflicht in drei Schichten
erfüllt:

1. **Konfigurierbare Aufbewahrungsfenster**, je Mandant in `GremionConfig.retention`
   gehalten ([`gremion-ui/src/lib/server/config.ts`](../gremion-ui/src/lib/server/config.ts)).
   Standardwerte und Obergrenzen stehen in einem einzigen Register
   ([`gremion-ui/src/lib/retention-tiers.ts`](../gremion-ui/src/lib/retention-tiers.ts))
   und folgen der Betreiber-Obergrenze von 30 Tagen für jede Log-Klasse
   [D R29-I6] (R29-RETENTION-30-K); die früheren Stufen nach BSI-Mindeststandard (90/180
   Tage) und BayLDA sind abgelöst.
2. **Ein geplanter Purge-Job auf dem Host** (`gremion-purge.timer` -> `tenant-create purge-run`),
   der Plumbing- und Betriebszeilen, die älter als ihr Katalogfenster sind, hart löscht, und
   zwar einmal je Kernel-Datenbank eines Kunden, jeweils gegen die Datenebene des betreffenden
   Mandanten. Er läuft auf dem Host, nicht im SvelteKit-Serverprozess, und liest kein
   mandantenspezifisches Konfigurationsfeld: Seine Fenster sind Literale, die ein Test an
   `docs/compliance/retention-catalogue.md` bindet. Der Governance-Nachweis `audit_log` wird
   von ihm nicht bereinigt (siehe §2.1).
3. **Crypto-Shredding je Mandant beim Löschen**: Die Vernichtung eines Mandanten macht jedes
   von ihm je geschriebene Backup unbrauchbar und entfernt seine gesamte Datenebene. Die
   Löschung ist damit vollständig und unumkehrbar und kein weicher Tombstone über weiterhin
   vorhandenen Daten (siehe §3).

Jedes Aufbewahrungsfeld hat genau einen Mechanismus, der es durchsetzt. Die Zuordnung in §2
und der Löschvertrag in §3 sind der Vertrag. Überdauern personenbezogene Daten ihr
konfiguriertes Fenster oder bleiben die Daten eines gelöschten Mandanten wiederherstellbar,
ist das eine Lücke und kein Merkmal.

---

## 2. Aufbewahrungsfelder in der Konfiguration

Schema:
[`gremion-ui/src/lib/server/config.ts`](../gremion-ui/src/lib/server/config.ts)
(`GremionConfig.retention`). Harte Obergrenzen setzt `clampRetentionDays` aus dem
Stufenregister durch: in `writeConfig` und **bei jedem Lesen** der gespeicherten Konfiguration
(ein vor der Obergrenze gespeicherter Wert wie 90 wird also begrenzt; die Begrenzung schreibt
je Feld eine Warnung ins Log). Seit TASK-033-a sind die vier Felder nicht mehr editierbar: Die
Settings-API weist den gesamten Schlüssel `retention` mit HTTP 400 ab, und der Tab „Einstellungen“
ist schreibgeschützt. Die festen Fenster sind `RETENTION_DEFAULTS`; ein Test bindet sie an die
Fenster, die das Aufbewahrungsregister in den Log-Speicher rendert (`packages/retention`).

| Feld | Standard | Harte Obergrenze | Grundlage | Umsetzung |
|---|---|---|---|---|
| `access_logs_days` | 14 | **29** | Betreiber-Obergrenze 30 Tage [D R29-I6]; Art. 5 Abs. 1 lit. e DSGVO | bisher keine in der Anwendung (siehe Hinweis unten); die Edge-Dateien sind durch `docs/log-retention-policy.md` begrenzt |
| `app_logs_days` | 28 | **29** | Betreiber-Obergrenze 30 Tage [D R29-I6]; Art. 5 Abs. 1 lit. e DSGVO; Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse) | bisher keine in der Anwendung (siehe Hinweis unten) |
| `security_logs_days` | 27 | **29** | Betreiber-Obergrenze 30 Tage [D R29-I6] | keine in der Anwendung (siehe Hinweis unten); das Fenster des Log-Speichers (RC-LOG-SEC, 27 Tage). Die Tabelle `audit_log` ist nicht dieses Feld (siehe §2.1) |
| `security_nopii_logs_days` | 27 | **30** | Betreiber-Obergrenze 30 Tage [D R29-I6]; Betreiberwert [R31-I4a] | bisher keine in der Anwendung (siehe Hinweis unten) |

> **Betreiber-Obergrenze 30 Tage [D R29-I6] (R29-RETENTION-30-K).** Keine Log-Klasse wird
> länger als 30 Tage aufbewahrt. Die Obergrenzen betragen 29 Tage dort, wo ein täglicher
> Purge das Fenster durchsetzen würde (29 Tage + 24 h Takt = 30 Tage);
> `security_nopii_logs_days` behält die Obergrenze 30.
> **In gremion-ui bereinigt nichts nach einem der vier Felder** (TASK-033-a): Der
> prozessinterne Purge-Takt für `audit_log` ist entfernt, und kein Feld wird gelesen, um
> etwas zu löschen. Die Werte sind die festen Fenster des Log-Speichers (Loki, aus dem
> Register gerendert) und des Löschkonzept-Textes; der Tab „Einstellungen“ und das erzeugte
> Löschkonzept sagen das auch. Das einzige Datenbankfenster, das der tägliche Host-Purge
> anwendet, ist `plt.job_run`: 29 Tage (RC-OPS-RUN folgt RC-LOG-APP, 30 Tage regulär und als
> Obergrenze, abzüglich des täglichen Takts). Die Logs von Edge und Identity-Provider sind
> unabhängig davon begrenzt und halten die Obergrenze bereits ein: rohe Zugriffs- und
> Traefik-Logs 14 Tage, pseudonymisierte Sicherheits- und Retained-Logs höchstens
> 29 Tage 2 h 5 min, Keycloak-Login- und Admin-Events 29 Tage
> (`docs/log-retention-policy.md`, „Upper bound“).

### 2.1 `audit_log` (Postgres): ein Governance-Nachweis, nie durch einen Timer bereinigt

Das Postgres-`audit_log` ist die globale, manipulationserkennbare Audit-Spur der Governance,
die die Audit-Oberfläche der Betreiber:innen und externe Compliance-Prüfer:innen heranziehen.
**Es ist ein Governance-Nachweis** (RC-GOV-CHAIN in
[`compliance/retention-catalogue.md`](compliance/retention-catalogue.md); Betreiberentscheidung
vom 2026-10-28): Kein Timer löscht daraus, es gehört nicht zu den vier oben genannten Log-Stufen,
und die Anwendungsrolle kann ausschließlich anhängen.

- **Tabelle:** `audit_log` (Spalten: `id`, `created_at`, `user_id`, `field`,
  `old_value`, `new_value`, `correlation_id`, dazu die Kettenspalten
  `prev_hash` / `row_hash`).
- **Schreibzugriff:** `writeAuditEntry` in
  [`gremion-ui/src/lib/server/audit-db.ts`](../gremion-ui/src/lib/server/audit-db.ts).
  Schreibvorgänge der Governance-Domäne (Einstellungsänderungen, Bereitstellung von Gremien
  und Organisationseinheiten, Protokoll- und Beschlussereignisse) landen alle hier. Der Akteur
  (`user_id`) ist die UUID einer Person oder das Principal `<token>-service` einer Komponente,
  nie ein Name (Migration 0061, TRD-147); eine Sitzung ohne `sub` wird bereits am Eingang
  (`hooks.server.ts`) abgewiesen, sodass nie ein Akteur erfunden wird.
- **Manipulationserkennung (Governance-Invariante INV-1):** Ein `BEFORE INSERT`-Trigger
  verkettet jede Zeile per Hash: `row_hash = sha256(prev_hash || canonical(row))`,
  serialisiert je Datenbank über ein Advisory-Xact-Lock
  ([`gremion-ui/migrations/0043_audit_log_hash_chain.sql`](../gremion-ui/migrations/0043_audit_log_hash_chain.sql)).
  `verifyAuditChain()` (in `audit-db.ts`) ruft den datenbankinternen Prüfer
  `audit_log_verify_chain()` auf und liefert die ID der ersten gebrochenen Zeile oder
  `{ ok: true }`, wenn die Kette intakt ist.
- **Nur anhängend (append-only):** `ensureKernelAuditAppendOnly` (`packages/tenant-store`)
  entzieht PUBLIC, der App-Rolle und der Owner-Rolle DELETE, UPDATE und TRUNCATE auf
  `audit_log` (und jeden Schreibzugriff auf den Kettenanker). Das geschieht über den
  gehärteten Admin-Pfad (fixierter `search_path`, serverseitiges `format('%I')`, qualifizierte
  Namen) bei der Bereitstellung und bei `reconcile` (Prüfung `audit-append-only`). Bis TASK-192
  ist die App-Rolle Mitglied der Owner-Rolle; das ist daher eine Hürde gegen einen Fehler oder
  eine verirrte Anweisung, keine Isolation gegenüber einem Mandanten, der als sein eigener
  Owner beliebiges SQL ausführt.
- **Löschersuchen:** werden durch Schwärzung beantwortet, nicht durch Löschen der Kette
  (Katalog §8).
- **Kein Purge:** gremion-ui plant keinen Purge ein (`purgeAuditLogsOlderThan` und der
  prozessinterne Takt `audit-retention` sind entfernt), und der Host-Job
  `gremion-purge.timer` (`purge-run`) tut es ebenso wenig: `PURGE_RULES` enthält keine Regel
  für `audit_log`, und ein Test schlägt fehl, sobald eine auftaucht. Die SQL-Funktion
  `audit_log_purge_before` aus Migration 0059 bleibt definiert, hat aber keinen Aufrufer.

### 2.2 Aufbewahrung je Modul

Der Kernel besitzt die Daten der Feature-Module nicht. Ein Modul, das personenbezogene Daten
speichert, bringt seine eigenen Aufbewahrungsfenster und Purge-Jobs zusammen mit seinem Schema
mit und registriert seinen Teardown-Hook, damit eine Mandantenlöschung es erreicht (§3). Der
Kernel garantiert nur die Fenster der obigen Tabelle und den Crypto-Shredding-Vertrag bei
Mandantenlöschung.

---

## 3. Mandantenlöschung: Crypto-Shredding-Vertrag

Das Löschen eines Mandanten muss sämtliche personenbezogenen Daten des Mandanten unwiederherstellbar
machen, einschließlich der bereits in Backups geschriebenen Daten. Der Kernel erreicht das mit
der Reihenfolge **Crypto-Shredding zuerst** statt mit einem weichen Statuswechsel.

- **Umsetzung:**
  [`gremion-ui/src/lib/server/tenant/provisioner/lifecycle.ts`](../gremion-ui/src/lib/server/tenant/provisioner/lifecycle.ts)
  (`deleteTenant`). Es ist reine Orchestrierung über injizierte Abhängigkeiten (ein
  Secret-Shredder, ein Executor zum Löschen der Datenbank, das Löschen des Keycloak-Realms,
  Registerfunktionen und ein optionaler Shred-Hook je Modul bzw. Leaf-Service); die
  Betreiber-CLI (`scripts/tenant-provision.ts`) liefert die echten Abhängigkeiten.

Die Reihenfolge ist fail-closed, und jeder Schritt ist idempotent und auch auf einen Mandanten im Endzustand
gefahrlos anwendbar:

1. **Status -> `deleting`** *vor* dem ersten zerstörenden Schritt, damit ein Absturz mitten in
   der Sequenz einen sichtbaren, fortsetzbaren Zustand der Control Plane hinterlässt. Der
   Mandanten-Resolver löst nur Zeilen mit `active` auf; ein Mandant in `deleting` ist daher
   sofort nicht mehr auflösbar, und während des Abbaus gibt es keine veraltete Auflösung.
2. **Zuerst den Backup-Schlüssel des Mandanten crypto-shreddern.** Der Backup-Schlüssel ist
   der einzige maßgebliche Ort der Backup-Verschlüsselung dieses Mandanten; seine Vernichtung
   macht sofort **jedes** Backup unbrauchbar, das der Mandant je geschrieben hat. Derselbe
   Schritt vernichtet jede aktive Credential-Datei des Mandanten (das
   Verbindungs-Secret der Datenebenen-DB und jedes Secret eines Confidential Clients). Das
   Vernichten einer bereits fehlenden Datei ist ein No-Op, ein erneuter Lauf ist also sicher.
3. **Datenebenen-DB und Rolle löschen** (`DROP DATABASE … IF EXISTS`).
4. **Registrierte Shred-Hooks der Module bzw. Leaf-Services ausführen** (optionale
   Abhängigkeit). Ein Modul mit mandantenspezifischem Speicher liefert einen Hook, der seine
   mandantenspezifische Datenbank löscht und seine Katalogzeile entfernt; beides ist
   idempotent. Ist der Hook nicht konfiguriert, gelingt das Löschen trotzdem. Ist er
   konfiguriert, bricht ein echter Fehler das Löschen ab, **bevor** der Tombstone geschrieben
   wird; der Mandant bleibt dann in `deleting`, und das Löschen lässt sich wiederholen.
5. **Keycloak-Realm löschen** (`DELETE /admin/realms/<realm>`; ein 404 ist ein No-Op). Damit
   verschwinden die Identitäten, Sitzungen und Event-Tabellen des Mandanten.
6. **Tombstone:** Status -> `deleted` (Endzustand), und die Laufzeitinstanz wird verdrängt.

**Die Wiederverwendung von Bezeichnern ist verboten (Schutz gegen Subdomain-Takeover).** Der
Tombstone ist endgültig: Die erneute Bereitstellung eines gelöschten Slugs wird abgelehnt
(abgesichert in `pipeline.provisionTenant`), und ein erneutes Löschen einer Tombstone-Zeile
ist ein No-Op, der den Endzustand respektiert. Der Slug bleibt für immer reserviert.

**Der Standard-Mandant (Bootstrap-Mandant) ist nie löschbar.** Er ist die Wurzel des globalen
Stacks und wird nicht über den Mandanten-Lebenszyklus verwaltet. `deleteTenant` lehnt sowohl
den Eingabe-Slug `default` als auch jede aufgelöste Zeile mit dem Slug `default` hart ab.

---

## 4. Datenisolation je Mandant

Das Crypto-Shredding beim Löschen ist nur deshalb vollständig, weil die Daten jedes Mandanten
von Anfang an physisch isoliert sind. Die Provisionierungs-Pipeline
([`gremion-ui/src/lib/server/tenant/provisioner/pipeline.ts`](../gremion-ui/src/lib/server/tenant/provisioner/pipeline.ts),
`provisionTenant`) gibt jedem Mandanten:

- seine **eigene Postgres-Datenbank samt Rolle** (`t_<slug>`), wobei die vollständige
  Verbindungs-URL in eine mandantenspezifische Secret-Datei geschrieben wird (nie in die
  gemeinsame Control-Plane-DB);
- seinen **eigenen Keycloak-Realm** (Identitäten, Sitzungen, OIDC-Clients, Event-Tabellen),
  gesetzt auf `sslRequired:'all'`;
- seinen **eigenen Backup-Verschlüsselungsschlüssel**, das Ziel des Crypto-Shreddings aus §3;
- seine eigenen Secrets für Confidential Clients.

Weil Daten, Credentials und Backup-Schlüssel allesamt mandantenspezifisch sind, kann der
Purge oder das Löschen eines Mandanten nie einen anderen berühren, und ein einzelnes
Crypto-Shredding macht genau die Backups eines Mandanten unbrauchbar.

---

## 5. Verweis auf das Löschkonzept

Das deutschsprachige Löschkonzept, das für Anfragen betroffener Personen erforderlich ist,
wird **bei Bedarf erzeugt**. Die Angaben zur bzw. zum Verantwortlichen, zur bzw. zum
Datenschutzbeauftragten und zum Zweck stammen aus der aktuellen Konfiguration des Mandanten; die
**Löschfristen sind die festen Fenster des Produkts** (`RETENTION_DEFAULTS`, durch Tests an das
Register des Log-Speichers und an den Katalog gebunden). Ein gespeicherter Wert
`config.retention.*`, den nichts durchsetzt, kann daher nie als Frist ausgegeben werden, die
nicht angewendet wird.

- **Generator:** `generateLoeschkonzept(config, asOf)` in
  [`gremion-ui/src/lib/server/loeschkonzept.ts`](../gremion-ui/src/lib/server/loeschkonzept.ts).
- **Eingaben:** die mandantenspezifischen Felder `compliance.controller_*` /
  `compliance.dpo_*` / `compliance.purpose_description`. Der gespeicherte Block `retention`
  wird **nicht** gelesen.
- **Ausgabe:** ein Markdown-Dokument mit: verantwortlicher Stelle (`§1`),
  Verarbeitungszweck und Rechtsgrundlage nach Art. 6 DSGVO (`§2`), Aufbewahrungstabelle je
  Datenkategorie (`§3`; die Spalte „Grundlage“ nennt die Betreiber-Obergrenze, und eine Stufe
  ohne Purge-Verbraucher trägt den Hinweis `RETENTION_CAVEATS`, dass es sich um Konfiguration
  und nicht um ein durchgesetztes Löschfenster handelt; eine weitere Zeile stellt fest, dass
  die Tabelle `audit_log` ein Governance-Nachweis (RC-GOV-CHAIN) ist, den kein Timer löscht),
  technischen Löschmechanismen (`§4`: IP-Pseudonymisierung, Vector + logrotate, verschlüsselte
  Backups mit automatischer Bereinigung, tägliche Rotation des Pseudonymisierungsschlüssels,
  tägliche Löschung der Betriebszeilen durch den Host-Job) sowie der Aussage, dass die Fristen
  fest sind und sich nur mit einer Programmversion ändern (`§5`).

Wird `GremionConfig.retention` um eine neue Aufbewahrungskategorie erweitert, **muss** die
Vorlage des Löschkonzepts in derselben Änderung erweitert werden, sonst weist das erzeugte
Dokument betroffenen Personen die Aufbewahrung unvollständig aus.

---

## 6. Harte Obergrenzen

`writeConfig` ([`config.ts`](../gremion-ui/src/lib/server/config.ts)) begrenzt bei jedem PATCH
jedes Aufbewahrungsfeld auf sein Richtlinienmaximum, und `readConfig` tut dasselbe mit einem
gespeicherten Wert:

```ts
// gremion-ui/src/lib/retention-tiers.ts — the one place the numbers live
RETENTION_CAPS = { access_logs_days: 29, app_logs_days: 29,
                   security_logs_days: 29, security_nopii_logs_days: 30 }
```

Betreiber-Obergrenze 30 Tage [D R29-I6]: Die Obergrenzen betragen 29 Tage dort, wo ein
täglicher Purge das Fenster durchsetzen würde (29 Tage + 24 h = 30 Tage), und 30 Tage für die
Stufe ohne personenbezogene Daten (§2). Die Obergrenzen beschränken, was `writeConfig`
speichert; die Settings-API nimmt keinen Schlüssel `retention` an (§2), sie schützen also vor
einer von Hand bearbeiteten Konfigurationsdatei, nicht vor einer Oberfläche.

Weitere harte Grenzen ohne Bezug zur Aufbewahrung, die in derselben Funktion durchgesetzt
werden:

- `backups.retention_days` ist nach unten auf **7** begrenzt (`Math.max(7, ...)`); ein Mandant
  kann Backups also nicht abschalten, indem er das Fenster auf null setzt.
- Die IDs aus `REQUIRED_MODULES` werden bei jedem Schreibvorgang fest auf `true` gesetzt. Im
  reinen Governance-Kernel ist diese Menge **leer** (`core` und `governance` sind nicht
  abschaltbare Manifeste und keine Einträge in `REQUIRED_MODULES`), der Kernel erzwingt also
  kein Feature-Modul; ein Feature-Modul steuert seine eigenen erforderlichen IDs bei, wenn es
  vorhanden ist.
- `setup_complete` ist nur anhängend (`current.setup_complete || update === true`): Ist die
  Einrichtung abgeschlossen, lässt sich der Assistent nicht über einen Schreibzugriff auf die Konfiguration
  erneut aufrufen.

Es gibt keine Oberfläche, um eine Obergrenze anzuheben. Um sie zu ändern, ist
`gremion-ui/src/lib/retention-tiers.ts` zu bearbeiten (die Settings-API, der Tab „Einstellungen“
und `infra/hardening/values.yaml` folgen ihr; ein Guard-Test schlägt fehl, wenn eine davon eine
eigene Kopie führt), die Vorlage des Löschkonzepts zu erweitern (§5) und §2 dieses Dokuments
zu aktualisieren.
