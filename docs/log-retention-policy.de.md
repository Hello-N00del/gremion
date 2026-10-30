<!-- i18n-sync: source=log-retention-policy.md sha256=ca4d11ee363947a6566acdb28b8f691ac330acf69458e8d3bcb52d6d9ed4f24c -->
[English](./log-retention-policy.md) | **Deutsch**

# Richtlinie zur Aufbewahrung von Logs

**Geltungsbereich:** Alle Dienste des Gremion-Governance-Kernels
**Rechtsgrundlage (Art. 6 DSGVO):** berechtigtes Interesse (Sicherheitsüberwachung, Reaktion auf Vorfälle, Missbrauchsprävention)

> Dies ist die operative Richtlinie für die Logs, die der Governance-Kernel erzeugt. Zu
> Architektur, Diensten und Entwurfsprinzipien des Kernels siehe
> [about-gremion.de.md](./about-gremion.de.md). Ausgelagerte Funktionsmodule (Finanzen,
> Dateien, Nachrichten, Wahlen, Inhalte usw.) liegen in eigenen Repositories, eines je
> Modul, und haben eigene Aufbewahrungsrichtlinien.

---

## Zusammenfassung

Logs, die personenbezogene Daten enthalten können (vor allem Client-IP-Adressen, dazu
Nutzer- und Mandantenkennungen), unterliegen den unten genannten Aufbewahrungsgrenzen. Der
Kernel wird mit Docker Compose betrieben; stdout/stderr der Container erfasst der
Docker-Log-Treiber `json-file`, und die Aufbewahrung der Zugriffslogs setzt eine eigene
Vector-Pipeline durch. Personenbezogene Daten in Zugriffslogs werden pseudonymisiert, bevor
sie überhaupt gespeichert werden, und alle Aufbewahrungsfenster sind durch serverseitige
harte Obergrenzen begrenzt.

**Betreiber-Obergrenze [D R29-I6] (2026-09-30, R29-RETENTION-30):** Keine Log-Klasse, die der
Edge oder der Identity-Provider vorhält, ist älter als **30 Tage**, auch die
pseudonymisierten Sicherheits- und Retained-Logs nicht. Die Edge-Dateien, das eigene Log von
Traefik und der Event-Speicher von Keycloak werden per Konfiguration darauf begrenzt und
nachgewiesen durch `docker/vector/test-edge-retention-bound.sh`, die 60-Tage-Simulation
`docker/vector/test-edge-retention-sim.sh` und `test/edge-log-retention.bats` (siehe
„Obergrenze“). Die Stufen auf Anwendungsebene unter „Konfiguration der Aufbewahrung“ tragen
dieselbe Obergrenze (R29-RETENTION-30-K); keine davon hat in der Anwendung einen
Löschkonsumenten, es handelt sich um Konfiguration und um die Fenster des Log-Speichers.

---

## Architektur

```
 Traefik (edge, production)
   ├─ writes its own ERROR log ────────────────► traefik-logs volume
   │    (/logs/traefik.log, not stdout)               │ (rotated in place by the loop)
   └─ writes raw JSON access log ─────────────► traefik-logs volume
                                                       │
 vector container                                      │ tails
   ├─ process-logs.sh   ◄──────────────────────────────┘
   │     • keeps only security-relevant paths (/auth, /realms, /api, /admin)
   │     • pseudonymises ClientHost with ipcrypt-nd
   │     • redacts query strings (?<redacted>)
   │     └─ appends to /logs/processed/security.log
   ├─ vector.toml       (retention filter)
   │     • drops events older than LOG_RETENTION_SECONDS
   │     └─ writes date-partitioned /logs/processed/retained-YYYY-MM-DD.log
   └─ rotation loop     (hourly: logrotate rotates + compresses + ages out the
                          live logs, state file on the processed-logs volume;
                          prune-retained.sh deletes retained day files by the
                          date in their name)
```

Quelle: `docker/vector/` (`process-logs.sh`, `vector.toml`, `logrotate.conf`,
`prune-retained.sh`, `entrypoint.sh`). Der Vector-Dienst läuft in jedem Deployment, das
Traefik betreibt (Produktionsprofil); die lokale Entwicklung stellt Dienste über direkte
Ports bereit und hat kein Traefik-Zugriffslog, das zu verarbeiten wäre.

---

## Aufbewahrung je Dienst

### Container-Logs (alle Dienste)

| Daten | Aufbewahrung | Löschmechanismus |
|------|-----------|-------------------|
| Anwendungslogs auf stdout/stderr (postgres, gremion-ui, gremion-public, legal, vector, mailpit und die übrigen Dienste) | Begrenzt durch die **Größe**, nicht durch die Zeit | Docker-Treiber `json-file` mit `max-size: 50m`, `max-file: 5` bei jedem Dienst in `docker-compose.yml`. Alte Abschnitte werden ausschließlich nach Größe rotiert, ein ruhiger Dienst kann eine Zeile daher länger als 30 Tage behalten. **Benannter Restposten [R29-RETENTION-30, Q17]:** Dies sind Anwendungslogs (die Klassen von TASK-033), keine Logs des Edge oder des Identity-Providers; die dauerhafte zeitliche Begrenzung liefert der Log-Shipper, den TASK-033 baut |
| Keycloak stdout | Keine Event-Zeilen | `KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_ERROR_LEVEL: debug` am Dienst keycloak: Der Standard-Listener `jboss-logging` würde jedes Fehler-Event (`LOGIN_ERROR` mit `ipAddress` und `username`) auf WARN nach stdout schreiben; auf debug bleibt es beim Standard-Root-Level INFO von stdout fern. Die Events bleiben im Event-Speicher, siehe „Keycloak“ |
| Traefik stdout | Nur Start-Zeilen | `log:` in `docker/traefik/traefik.yml` schreibt das eigene JSON-Log von Traefik auf ERROR-Level nach `/logs/traefik.log` auf dem Volume `traefik-logs`, rotiert von der Vector-Schleife (14 Tage, siehe „Traefik-Zugriffslogs“). Lesen mit `docker exec <vector container> cat /logs/traefik/traefik.log`; `docker logs` von Traefik zeigt Laufzeitfehler nicht mehr an |

Anwendungslogs sind betriebliche Aufzeichnungen, keine Audit-Nachweise. Die beiden Quellen
von Client-Adressen auf stdout der Edge- und Identity-Provider-Container sind geschlossen:
Das Laufzeitlog von Traefik geht in eine rotierte Datei, und die Event-Zeilen von Keycloak
bleiben von stdout fern (beides oben). Würde `KC_LOG_LEVEL` auf debug angehoben, kämen die
Event-Zeilen von Keycloak zurück.

---

### Traefik-Zugriffslogs (Produktion)

| Daten | Aufbewahrung | Löschmechanismus |
|------|-----------|-------------------|
| Rohes JSON-Zugriffslog (`/logs/traefik/access.log`, enthält `ClientHost`) | 14 Tage auf dem Datenträger | Regel in `logrotate.conf`: `daily`, `maxage 14`, `rotate 14`, `compress`, `ifempty`, `copytruncate`. Vector liest diese Datei nur mit (**tail**); sie wird an Ort und Stelle rotiert, sodass der schreibende Prozess denselben FD behält |
| Eigenes Log von Traefik (`/logs/traefik/traefik.log`, Level ERROR; kann eine Client-Adresse nennen) | 14 Tage auf dem Datenträger | Dieselben Regelwerte wie beim Zugriffslog. Traefik schreibt es selbst (`docker/traefik/traefik.yml` `log.filePath`) statt auf stdout des Containers. `log.maxSize: 1000000` (MB) schaltet die eigene Größenrotation von Traefik ab: Ist `filePath` gesetzt, schreibt Traefik über einen größenrotierenden Writer (0 bedeutet 100 MB, jedes Backup bleibt für immer erhalten, und der Größenzähler ignoriert `copytruncate`), und jenseits der Grenze würde er die aktive Datei in `traefik-<timestamp>.log.gz` umbenennen, einen Namen, auf den keine Regel hier passt, sodass ihn nie etwas löschen würde. Das Begrenzungsmodell verlangt eine Grenze, die kein Volume erreicht, damit logrotate der einzige Rotator ist |
| Pseudonymisiertes Sicherheitslog (`/logs/processed/security.log`) | 27 Tage konfiguriert, höchstens 29 d 2 h 5 min auf dem Datenträger | Regel in `logrotate.conf`: `daily`, `maxage 27`, `rotate 27`, `compress`, `ifempty`, `copytruncate` |
| Nach Datum partitionierte Retention-Senke (`/logs/processed/retained-YYYY-MM-DD.log`) | 27 Tage nach dem Datum im Dateinamen (heute − 27 … heute, UTC) | Die Transformation `enforce_retention` von Vector verwirft beim Einlesen Events, die älter als `LOG_RETENTION_SECONDS` sind; `prune-retained.sh`, stündlich von der Schleife in `entrypoint.sh` ausgeführt, löscht jede Form einer Tagesdatei (Basis, `.log.N`, `.log.N.gz`) mit Datum vor heute − 27 (`RETAINED_RETENTION_DAYS`, Standard 27). Das `maxage` von logrotate kann das nicht leisten: Es wird nur bei einer Rotation geprüft, und `notifempty` beendet die Rotationen einer Tagesdatei nach der ersten |
| Zustand von logrotate (`/logs/processed/.logrotate.status`) | Wird behalten | `logrotate -s` in der Schleife: auf dem Volume für verarbeitete Logs, damit ein Neuanlegen des Containers den Tag der Erstbeobachtung jeder aktiven Datei nicht neu beginnt |

#### Obergrenze

**B = 30 Tage** [D R29-I6]: Kein Datensatz, den eine Edge-Datei hält, ist älter als
2592000 s. Die Rechnung steht an einer einzigen Stelle, in
`docker/vector/test-edge-retention-bound.sh` (statisch: Das Skript liest `logrotate.conf`, den
Prune-Standardwert, die Intervallbegrenzung des Entrypoints und `docker/traefik/traefik.yml`)
und gibt folgende Tabelle aus:

```
Edge retention bound: B = 2592000 s (30d 0h 0m); I = 3600 s, R = 300 s, L = 90000 s
family           formula                          seconds  duration
access.log       (14+1) d + I + R                 1299900  15d 1h 5m  ok
traefik.log      (14+1) d + I + R                 1299900  15d 1h 5m  ok
security.log     (27+1) d + I + R + L             2513100  29d 2h 5m  ok
retained-*.log   (27+1) d + I + R + L (W=27)      2513100  29d 2h 5m  ok
```

`I` ist das Schleifenintervall, vom Entrypoint auf 60 … 3600 s begrenzt (ein Wert der
Betreiber:in außerhalb dieses Bereichs oder ein Nicht-Integer wird mit einer stderr-Zeile
durch 3600 ersetzt). `R` = 300 s ist der Spielraum für einen Schleifendurchlauf (logrotate +
Kompression + Prune); die Simulation schlägt fehl, wenn ein Durchlauf länger dauert. `L` ist
die Einlese-Verzögerung eines Datensatzes, den `tail -F` in `process-logs.sh` nach einem
Container-Neustart erneut einliest (er liest die letzten 10 Rohzeilen noch einmal, höchstens
1 d + `I` alt); sie gilt nur für `security.log` und die Retained-Familie. Deshalb sind 27
Tage konfiguriert und nicht 28: Mit 28 erreicht der Wiedereinlese-Fall 30 d + 2 h 5 min, über
B.

Jede Regel ist `daily`, und ihr `maxage` entspricht ihrem `rotate`. **Kein aktives Log trägt
`notifempty`**: Mit dieser Option übersprang ein Tag ohne Verkehr die Rotation, und `maxage` wird nur bei
einer Rotation geprüft, sodass eine ruhige Phase (oder ein Container-Stopp) die aktive Datei
über jede Grenze hinaus dehnte. Jeder ruhige Tag fügt nun eine winzige leere `.gz`-Datei
hinzu, die `rotate` begrenzt. `docker/vector/test-edge-retention-sim.sh` lässt die
ausgelieferte `logrotate.conf` und `prune-retained.sh` im gebauten Image durch das echte
logrotate über 60 simulierte Tage laufen (20 mit Verkehr, 20 ohne, 20 mit) und prüft an jedem
Tag jeden überlebenden Datensatz; `test/edge-log-retention.bats` führt das statische Modell
und seine Mutationswächter unter `verify` aus.

Benannte Restposten: Solange der Vector-Container gestoppt ist, wird nichts rotiert oder
bereinigt, und Traefik hängt weiter an; die Grenze gilt daher nur, solange der Container
läuft (die erste Schleife nach einem Start löscht, was inzwischen abgelaufen ist). Ein
gestoppter oder entfernter Vector-Container löst `ContainerUnhealthy2m` aus, wobei
`component` ihn benennt (`gremion:cond:container_unhealthy` in
`compose/observability/prometheus/rules.yml`, TASK-039), sodass die Betreiber:in binnen
Minuten davon erfährt. `tail -F` dupliziert bei jedem Neustart bis zu 10 Datensätze in
`security.log` (durch `L` abgedeckt; die Korrektur `tail -n 0 -F` gehört zu TASK-033, das
`process-logs.sh` verantwortet). Geht das Volume `vector-processed-logs` verloren, gehen
Sicherheits- und Retained-Dateien mit, und die Traefik-Dateien umfassen dann einen Tag mehr
(weiterhin unter B).

**IP-Pseudonymisierung:** `process-logs.sh` führt die Client-IP durch `ipcrypt`
(`nd-encrypt`, formaterhaltend, mit dem Docker-Secret `ipcrypt_key` geschlüsselt), bevor
irgendetwas in das verarbeitete Log geschrieben wird. Schlägt die Pseudonymisierung fehl,
wird die Zeile **verworfen**: Eine rohe IP wird nie gespeichert. Die Schlüsselepoche
(`IPCRYPT_KEY_EPOCH`) wird in jedem Datensatz vermerkt, damit eine spätere Schlüsselrotation
nachvollziehbar ist.

**NDJSON als verbindliches Format:** Das verarbeitete Log enthält je physischer Zeile ein kompaktes
JSON-Objekt (`jq -c`). Die `file`-Quelle von Vector, logrotate und grep-basierte
Audit-Werkzeuge arbeiten zeilenorientiert; ein eingerückt formatierter Datensatz würde
den Aufbewahrungsfilter als Zeilenfragmente ohne `RequestReceivedAt` erreichen und nie bereinigt werden.
`test/process-logs.bats` prüft das Zeilenformat unter verify (mit einem
`ipcrypt`-Stub), und `docker/vector/test-process-logs.sh` prüft es mit der echten Binärdatei.

**Schwärzung von Query-Strings:** Traefik protokolliert den vollen Anfragepfad einschließlich
Query-String. `process-logs.sh` entfernt alles ab dem ersten `?` (und ersetzt es durch
`?<redacted>`), sodass OIDC-Autorisierungscodes, `session_code`-Werte von Keycloak und
ähnliche Geheimnisse in Query-Parametern nie gespeichert werden. Der Pfad selbst bleibt
erhalten.

**Pfadfilterung:** Nur sicherheitsrelevante Pfade (`/auth`, `/realms`, `/api`, `/admin`)
werden überhaupt in das verarbeitete Log geschrieben. Jede andere Anfrage wird verworfen und
nirgends gespeichert.

---

### Keycloak (Identität und Authentifizierung)

| Daten | Aufbewahrung | Löschmechanismus |
|------|-----------|-------------------|
| Anwendungslogs | Keine Event-Zeilen; im Übrigen durch die Größe begrenzt | Flüchtiges stdout, vom Docker-Treiber `json-file` rotiert (nur nach Größe). Event-Zeilen (`LOGIN_ERROR` usw.) bleiben durch `KC_SPI_EVENTS_LISTENER_JBOSS_LOGGING_ERROR_LEVEL: debug` (Compose, Dienst keycloak) von stdout fern; das alte Container-Log verschwindet mit dem Neuanlegen beim Rollout |
| Login-/Auth-Events (`EVENT_ENTITY`, kann die Login-IP speichern) | 29 Tage (ungünstigster Fall 29 d + 15 min) | `eventsExpiration: 2505600` in `docker/keycloak/realm-export.base.json`; der Scheduler von Keycloak (standardmäßig 900 s) bereinigt abgelaufene Events automatisch |
| Admin-/Audit-Events (`ADMIN_EVENT_ENTITY`) | 29 Tage (ungünstigster Fall 29 d + 15 min) | Das Realm-Attribut `adminEventsExpiration: "2505600"` (`attributes` auf oberster Ebene, neben `acr.loa.map`, `adminEventsEnabled: true`). Seit Keycloak 23 liest die Bereinigung der Admin-Events dieses Attribut, **nicht** `eventsExpiration`; beide sind gesetzt. Gegen das gepinnte Image 26.6.1 nachgewiesen: Der Attributname wird von `JpaEventStoreProvider` gelesen, und bereits gespeicherte Events (angelegt, bevor die Ablaufzeit gesenkt wurde) werden ebenfalls bereinigt |
| Benutzersitzungen | `ssoSessionIdleTimeout: 7200s` / `ssoSessionMaxLifespan: 86400s` | Keycloak lässt inaktive und überalterte Sitzungen automatisch ablaufen; Auth.js-Cookies in gremion-ui laufen mit der Sitzung ab |

Die Realm-Datei greift, wenn ein Mandanten-Realm angelegt wird. Bereits bestehende Realms
behalten die Werte, mit denen sie angelegt wurden; ihre `eventsExpiration` und
`adminEventsExpiration` anzugleichen (Attribute zusammengeführt, `acr.loa.map` unberührt),
ist ein Folgeschritt im Realm-Reconcile von gremion-ui, verantwortet von der Ergänzung zu
TASK-033.

---

### PostgreSQL

| Daten | Aufbewahrung | Löschmechanismus |
|------|-----------|-------------------|
| Query-Logs | Nicht aktiviert | `log_statement = 'none'` (PostgreSQL-Standard): Statements werden nicht protokolliert |
| Governance-Fachdaten (Gremien, Mitglieder, Organisationseinheiten, Protokolle, Beschlüsse) | Bis zur Löschung durch die Betreiber:in | Kein automatischer Ablauf von Daten; Löschung auf Veranlassung der Betreiber:in über die Admin-Shell |
| INV-1-Audit-Log (hash-verkettete Governance-Audit-Spur) | Kein Ablauf per Timer: ein Governance-Nachweis (RC-GOV-CHAIN, Aufbewahrungskatalog; Entscheidung der Betreiber:in vom 2026-10-28). Es unterliegt nicht `security_logs_days` | Ein Integritätsnachweis, kein rotierendes Log. Nichts bereinigt es: gremion-ui plant keine Bereinigung, der Host-Job `gremion-purge.timer` hat keine `audit_log`-Regel, und die Anwendungsrolle (und die Eigentümerrolle, deren Mitglied sie ist) hat keine Rechte DELETE, UPDATE oder TRUNCATE darauf (`ensureKernelAuditAppendOnly`, bei der Bereitstellung und bei `reconcile`). Ein Löschverlangen einer Person wird durch Schwärzung beantwortet, nicht durch Löschen der Kette. Die Funktion `audit_log_purge_before` für ein gealtertes Präfix aus Migration 0059 bleibt definiert und hat keinen Aufrufer |

Das INV-1-Audit-Log hält Governance-Handlungen fest (wer unter welchem Quorum und
welcher Entscheidungsregel was beschlossen hat). Es ist ausschließlich anfügbar: Keine Zeile
wird aktualisiert oder gelöscht, weder von der Anwendung noch von einem Timer. Es ist ein
Governance-Nachweis (die Lücke G6 im Aufbewahrungskatalog ist durch die Entscheidung der
Betreiber:in vom 2026-10-28 geschlossen), daher gelten weder die Edge-Log-Regeln oben noch die vier
Log-Fenster unten für das Audit-Log.

---

## Konfiguration der Aufbewahrung

Die Aufbewahrungsfenster werden in `.env` gesetzt (siehe `.env.example`, Abschnitt
„Hardening“). Die Werte sind in Sekunden angegeben (Tage × 86400) und durch serverseitige
harte Obergrenzen begrenzt:

| Variable | Standard | Harte Obergrenze |
|----------|---------|----------|
| `LOG_ACCESS_RETENTION_SECONDS` | 14 Tage (1209600) | 29 Tage (2505600) |
| `LOG_APP_RETENTION_SECONDS` | 28 Tage (2419200) | 29 Tage (2505600) |
| `LOG_SECURITY_RETENTION_SECONDS` | 27 Tage (2332800) | 29 Tage (2505600) |
| `LOG_SECURITY_NOPII_RETENTION_SECONDS` | 27 Tage (2332800) | 30 Tage (2592000) |

Betreiber-Obergrenze 30 d [D R29-I6], R29-RETENTION-30-K: Keine Angabe in dieser Tabelle
überschreitet sie. Standardwerte und Obergrenzen sind die der Aufbewahrungsstufen von
gremion-ui (`gremion-ui/src/lib/retention-tiers.ts`, ein einziges Register, das die
Konfigurationsbegrenzung, die Settings-API und der Settings-Tab alle lesen): 29 d dort, wo
eine tägliche Bereinigung das Fenster durchsetzen würde (29 d + 24 h = 30 d), 30 d für die Stufe
ohne Löschkonsumenten. Eine gespeicherte Konfiguration mit einem höheren Wert (die früheren
90 / 180 / 365 Tage) wird beim Lesen begrenzt, und die Begrenzung schreibt je Feld eine
Warnung ins Log. Nur `LOG_ACCESS_RETENTION_SECONDS` wird von `docker-compose.yml` gelesen;
die anderen drei dokumentieren die Standardwerte der Stufen.

**TASK-033-a (Q6):** Die vier Stufen sind keine Einstellung mehr, die eine Admin ändern kann:
Die Settings-API weist den gesamten Schlüssel `retention` zurück (400), und der Tab ist
schreibgeschützt. Die Fenster legt das Aufbewahrungsregister fest (`packages/retention`, eine
Quelle mit `docs/compliance/retention-catalogue.md`), und die Loki-Konfiguration wird daraus
erzeugt (`docker/loki/loki.yaml`). **In gremion-ui bereinigt nichts nach einem der vier
Felder, und keines davon wird von etwas gelesen, das löscht**: Der prozessinterne
`audit_log`-Tick ist entfernt (`audit_log` ist ein Governance-Nachweis, siehe „PostgreSQL“
oben). Die tägliche Host-Bereinigung (`gremion-purge.timer`, `purge-run`) wendet die
Datenbankfenster aus `PURGE_RULES` an: die Hilfstabellen `event_consumption` und
`scheduled_notifications` (7 d) und `plt.job_run` (29 d), und sie schreibt eine
Ergebniszeile in `plt.job_run`. Die Werte sind Konfiguration und Text des Löschkonzepts; der
Settings-Tab und das erzeugte Löschkonzept weisen darauf hin. Die Edge-Dateien sind unabhängig von
diesen Werten begrenzt (siehe „Obergrenze“); stdout der Container bleibt ausschließlich nach
Größe begrenzt (siehe „Container-Logs“).

Der Vector-Container erhält `LOG_RETENTION_SECONDS` (abgeleitet aus
`LOG_ACCESS_RETENTION_SECONDS`) und setzt es in der Transformation `enforce_retention`
durch. Die Pfade `IPCRYPT_KEY_FILE` / `IPCRYPT_KEY_EPOCH` und `RAW_LOG_PATH` /
`PROCESSED_LOG_PATH` werden am Dienst `vector` in `docker-compose.yml` konfiguriert.

---

## Hinweise zur DSGVO-Konformität

- **Datenminimierung (Art. 5 Abs. 1 lit. c DSGVO):** Client-IPs werden mit ipcrypt-nd
  pseudonymisiert, bevor ein Zugriffslog-Datensatz gespeichert wird; rohe IPs werden nie
  geschrieben. Query-Strings (die Codes oder Token tragen können) werden geschwärzt.
  Nicht sicherheitsrelevante Anfragepfade werden vollständig verworfen.
- **Speicherbegrenzung (Art. 5 Abs. 1 lit. e DSGVO):** Die Aufbewahrung der Zugriffslogs
  beträgt standardmäßig 14 Tage und ist hart auf 29 Tage begrenzt; die pseudonymisierten
  Sicherheits- und Retained-Logs werden auf höchstens 29 d 2 h 5 min gehalten, die Login-
  und Admin-Events von Keycloak auf 29 Tage (Betreiber-Obergrenze 30 d [D R29-I6]). Jedes
  Fenster hat eine serverseitig durchgesetzte Obergrenze. Die Stufen auf Anwendungsebene
  tragen dieselbe Obergrenze (Standardwerte 14 / 28 / 27 / 27 d, Obergrenzen 29 / 29 / 29 /
  30 d); keine davon ist eine Bereinigung in der Anwendung (siehe „Konfiguration der
  Aufbewahrung“; die Tabelle `audit_log` ist ein Governance-Nachweis und keine der vier
  Stufen).
- **Integrität (Art. 5 Abs. 1 lit. f DSGVO / Hash-Kette):** Das INV-1-Governance-Audit-Log ist
  ausschließlich anfügbar und wird von keinem Timer gelöscht (RC-GOV-CHAIN; siehe
  „PostgreSQL“; die Lücke G6 im Aufbewahrungskatalog ist durch die Entscheidung der
  Betreiber:in vom 2026-10-28 geschlossen).
- **Meldung von Verletzungen:** Bei einer Verletzung des Schutzes personenbezogener Daten
  muss die Betreiber:in die zuständige Aufsichtsbehörde binnen 72 Stunden benachrichtigen
  (Art. 33 DSGVO).

---

## Zentrale Protokollierung

Das Standard-Deployment des Kernels hält Logs auf dem Host (Docker-Log-Treiber + die
Volumes der Vector-Pipeline). Betreiber:innen, die Logs an ein zentrales Backend (z. B.
Loki, Elasticsearch) ausleiten, müssen dort eine Aufbewahrung konfigurieren, die den obigen
Fenstern entspricht oder strenger ist. Die Pseudonymisierung geschieht, bevor das
verarbeitete Log geschrieben wird; ein nachgelagerter Collector erhält also bereits
pseudonymisierte Zugriffsdatensätze.

**Der Log-Speicher der Betreiber:in (TASK-039).** Das Ops-Projekt
(`compose/observability/`) betreibt Loki mit aktivierter Aufbewahrung im Compactor (Compactor-Retention; Lokis
Standard behält jede Zeile für immer) und einem Stream je Klasse des Aufbewahrungskatalogs
(Abschnitt 4.1), jeder im ungünstigsten Fall unter der 30-Tage-Obergrenze [D R29-I6]
gehalten (Fenster + 24 h Index-Periode + 2 h Löschverzögerung + 10 min
Compaction-Intervall):

| Loki-Stream | Fenster | Ungünstigster Fall | Gespeist von |
|---|---|---|---|
| `class="access"` | 14 Tage | 15 d 2 h 10 min | (reserviert für die Zugriffsklassen von TASK-033) |
| `class="security"` | 27 Tage | 28 d 2 h 10 min | `security.log` von Vector, von Alloy nur gelesen |
| `class="finance"` | 27 Tage | 28 d 2 h 10 min | (reserviert für das Finanz-Log, TASK-033) |
| `class="audit"` | 27 Tage | 28 d 2 h 10 min | Eigenes Anfragelog von Grafana (der Nachweis des Betreiberzugriffs) |
| `class="application"` | 28 Tage [A] | 29 d 2 h 10 min | An den Ops-Ingest gepushte OTLP-Logs (TASK-116) |
| keine Klasse | 14 Tage | 15 d 2 h 10 min | alles Übrige |

Traces (Tempo) werden 7 Tage gehalten (RC-LOG-TRC), Metriken (Prometheus) 27 Tage:
Prometheus löscht nur ganze Blöcke, ein Block umfasst bis zu 10 % des Fensters, und die
Löschung folgt der zweistündlichen Compaction, sodass der älteste Messwert höchstens
29 d 19 h alt ist. `compose/observability/retention.test.mjs` schlägt bei jedem Fenster
fehl, dessen ungünstigster Fall 30 Tage überschreitet. Stdout der Container der
Dienste des Rats wird nicht ausgeleitet (kein Ops-Dienst darf das Docker-Datenverzeichnis
lesen), daher bleibt der oben genannte Restposten zu `json-file` unverändert.

---

Zur Compliance-Lage des Kernels im Allgemeinen siehe
[compliance.de.md](./compliance.de.md) und [about-gremion.de.md](./about-gremion.de.md).
