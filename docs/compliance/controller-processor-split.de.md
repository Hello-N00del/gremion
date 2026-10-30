<!-- i18n-sync: source=controller-processor-split.md sha256=21e8a4eb53a00de23bc1eda42573890901467207de25f8cd7158c4482be8cf26 -->
[English](./controller-processor-split.md) | **Deutsch**

# Rollenverteilung: Verantwortliche:r und Auftragsverarbeiter

> **Status: ENTWURF – beabsichtigte Aufteilung, keine abgeschlossene Vereinbarung.**
> Dieses Dokument beschreibt, wie die Rollen nach der DSGVO für Gremion in seinen beiden
> Betriebsformen *beabsichtigt* verteilt sein sollen. Stand 2026-09-09 ist **mit niemandem ein
> Auftragsverarbeitungsvertrag (AVV) abgeschlossen worden**, es ist kein Rat für den
> Pilotbetrieb benannt, und es werden keine personenbezogenen Daten eines realen Rats
> gehostet. Unterauftragsverarbeiter, für die ein unterzeichneter AVV erforderlich ist,
> sind mit `TBD` markiert, solange dieser AVV nicht vorliegt.
> Nichts hierin ist Rechtsberatung; die Analyse muss vor dem Onboarding des ersten realen
> Rats von Jurist:innen oder von einer/einem Datenschutzbeauftragten geprüft werden.

## 1. Die zwei Betriebsformen

**(a) Selbst betrieben.** Ein Rat (Rat / Gremium / Studierendenschaft) betreibt die
Gremion-Distribution auf eigener Infrastruktur oder auf der Infrastruktur seiner Einrichtung.
Eine Betreiber:in ist überhaupt nicht beteiligt. Siehe §11.

**(b) Gehostete Control Plane.** Die Betreiber:in des Projekts betreibt eine
Gremion-Installation auf einem einzelnen dedizierten Server, der bei der **netcup GmbH**
(Deutschland) gemietet ist, und hostet darauf mehrere Räte (Mandanten). Die Produkte sind
unter Subdomains der Plattform-Domain `gremion.de` erreichbar; ein Mandant kann zusätzlich
eine eigene Domain (`gremien.council.example`) auf dieselbe Installation zeigen lassen.
Jeder Mandant erhält eine eigene Postgres-Datenbank, einen eigenen Keycloak-Realm und
eigenes Secret-Material, registriert in einer separaten Control-Datenbank
(`migrations-control/001_tenant_registry.sql`). Form (b) macht die Betreiber:in zum
**Auftragsverarbeiter** und ist Gegenstand des restlichen Dokuments.

## 2. Rollen je Datenkategorie

| Datenkategorie | Wo sie liegt | Verantwortliche:r | Rolle der Betreiber:in |
|---|---|---|---|
| Inhalte des Rats: Mitglieder, Gremien, Rollen, Protokolle, Anträge, Finanzunterlagen, Dateien, Kalender, Wahlen | Postgres-DB `t_<slug>` pro Mandant, Modul-Stores pro Mandant, Objektspeicher | **Der Rat** | **Auftragsverarbeiter** (Art. 28) |
| Authentifizierungsdaten: Benutzernamen, E-Mail-Adressen, Zugangsdaten, Sitzungen, Login- und Step-up-Ereignisse | Keycloak-Realm pro Mandant | **Der Rat** | Auftragsverarbeiter |
| Audit-Trail des Mandanten (`audit_log`, hash-verkettet) | DB pro Mandant | **Der Rat** | Auftragsverarbeiter, wobei die Betreiber:in daran ein eigenes Sicherheitsinteresse hat (siehe §3) |
| Chat, Anrufe und geteilte Dateien über Matrix/Synapse, LiveKit, Nextcloud | Geteilte Subsysteme auf demselben Host | **Der Rat**, mit dem Risiko einer gemeinsamen Verantwortlichkeit (siehe §3) | Auftragsverarbeiter, umstritten |
| Backups der vorgenannten Daten | Lokales Volume; Offsite-Ziel `TBD` | **Der Rat** | Auftragsverarbeiter |
| Plattform-Konto- und Kontaktdaten: Vertrags- und Rechnungskontakte des Rats, Anmelde- und Support-Korrespondenz, Ticketinhalte | Eigene Systeme der Betreiber:in, Postfächer `hello@` / `signups@` | **Die Betreiber:in** | Verantwortliche:r |
| Infrastruktur-Logs: Zugriffslogs des Reverse Proxys, Container-Logs, Firewall- und Mail-Transport-Logs | Host | **Die Betreiber:in**, Art. 6 Abs. 1 lit. f DSGVO (Sicherheit und Betrieb des Dienstes) | Verantwortliche:r |
| Anwendungs-Logs, die Nutzer:innen eines Mandanten beschreiben | Host, Aufbewahrung nach §8 | **Der Rat** | Auftragsverarbeiter: kurzlebig und getrennt von den eigenen Logs der Betreiber:in halten |
| Ein- und ausgehende Mail der Plattform selbst (`security@`, `abuse@`, `postmaster@`, `hello@`) | Selbst betriebener Mail-Stack auf demselben Server | **Die Betreiber:in** | Verantwortliche:r |
| Mail, die die Plattform *für einen Mandanten* über dessen eigenes SMTP-Profil versendet | Eigener Mail-Provider des Mandanten | **Der Rat** | Keine Rolle: Der Provider des Mandanten ist Auftragsverarbeiter *des Mandanten* |
| Marketing-Website an der Apex-Domain, Quell-Repository, Issue-Tracker | Betreiber:in / GitHub | **Die Betreiber:in** | Verantwortliche:r |

Faustregel, die die Aufteilung ehrlich hält: **Die Betreiber:in verarbeitet Mandantendaten
nur auf dokumentierte Weisung (weisungsgebunden) und nie zu einem eigenen Zweck.** Sobald
die Betreiber:in mandantenübergreifende Analysen, Produkt-Telemetrie oder mandantenübergreifende
Missbrauchserkennung will, verlässt diese Datenkategorie Art. 28 und wird entweder zur
Verantwortlichkeit der Betreiber:in (die eine eigene Rechtsgrundlage braucht) oder zur gemeinsamen
Verantwortlichkeit nach Art. 26.

## 3. Risiken einer gemeinsamen Verantwortlichkeit (Art. 26)

Hier bestimmt die Betreiber:in die Mittel so stark, dass „reiner Auftragsverarbeiter“ eher
vertretbar als offensichtlich ist. Jeder Punkt braucht vor dem zweiten Mandanten eine
Entscheidung, weil jeder Defekt in einem geteilten Subsystem bei Mandant 2 wirksam wird,
nicht bei Mandant 1.

- **Matrix / Synapse: ein Homeserver, ein `server_name`.** Der `server_name` ist eine
  *Plattform*-Domain, bewusst weder die eines Produkts noch die eines Mandanten, damit
  Raum-IDs nicht dauerhaft einen Mandanten enthalten. Die Folge: Jede Benutzerkennung
  (`@user:<platform domain>`) wird in einem Namensraum vergeben, den die Betreiber:in
  besitzt, Raum-IDs enthalten dauerhaft die Domain der Betreiber:in, und der Medienspeicher
  ist geteilt. Die Föderation ist geschlossen, was die Exposition begrenzt, aber nichts
  daran ändert, wer den Namensraum der Kennungen bestimmt. Optionen: eine Rolle als
  Auftragsverarbeiter mit engen Weisungen akzeptieren und dokumentieren, oder vor Mandant 2
  auf einen Homeserver pro Mandant wechseln (Kosten).
- **LiveKit.** Geteilte SFU. Medien sind flüchtig, aber Raumnamen, Teilnehmeridentitäten
  und Anrufmetadaten laufen über eine von der Betreiber:in bestimmte Infrastruktur und
  Identitäts-Tokens.
- **Nextcloud.** Eine einzelne Instanz mit Gruppenordnern pro Mandant, gemeinsamer
  Benutzertabelle und gemeinsamer OIDC-Zuordnung. Das ist auch der Grund dafür, dass die
  Löschung eines Mandanten einen manuellen Rest hat (§7).
- **Mandantenübergreifende Audit- und Sicherheitsprotokollierung.** Der Inhalt des
  `audit_log` eines Mandanten dient dem Compliance-Zweck des Rats *und* dem Sicherheitszweck
  der Betreiber:in. Liest die Betreiber:in ihn für eigene Sicherheitszwecke, ist das offen
  zu sagen und mit einer Rechtsgrundlage zu versehen; das darf nicht als reine Verarbeitung
  auf Weisung dargestellt werden.

Wo gemeinsame Verantwortlichkeit die ehrliche Bezeichnung ist, verlangt Art. 26 eine
schriftliche Vereinbarung, die die Pflichten verteilt, und die Bereitstellung ihres
wesentlichen Inhalts für die betroffenen Personen. Eine solche Vereinbarung besteht
derzeit nicht.

## 4. AVV-Checkliste nach Art. 28 (was der Vertrag enthalten muss)

Kein Vertragsentwurf, sondern die Checkliste, an der der spätere AVV gemessen wird.

1. Gegenstand, Dauer, Art und Zweck der Verarbeitung.
2. Kategorien personenbezogener Daten und betroffener Personen (§2 oben und das Verzeichnis
   nach Art. 30 Abs. 2).
3. Verarbeitung **nur auf dokumentierte Weisung** der/des Verantwortlichen, einschließlich
   der Regelung für Weisungen mit Drittlandbezug.
4. Verpflichtung auf Vertraulichkeit für alle Personen mit Zugriff. Heute ist die
   Betreiber:in eine einzelne Person; die Verpflichtung muss trotzdem festgehalten werden,
   und das Risiko der Abhängigkeit von einer Schlüsselperson liegt ausdrücklich außerhalb
   des technischen Plans und ist organisatorisch zu regeln.
5. **TOM nach Art. 32** als Anlage (§4a).
6. Unterauftragsverarbeiter: allgemeine schriftliche Genehmigung plus eine Frist für die
   Benachrichtigung über Änderungen (`TBD`, typischerweise 30 Tage) und ein Widerspruchsrecht;
   aktuelle Liste in §5.
7. Unterstützung bei den Rechten betroffener Personen (Art. 12–22) – Export, Berichtigung,
   Löschung, Einschränkung – und bei den Pflichten nach Art. 32–36.
8. Löschung oder Rückgabe bei Vertragsende, mit genannter Frist und ausformulierter
   Backup-Ausnahme (§7).
9. Audit- und Nachweisrechte sowie die Nachweise, die die Betreiber:in liefert.
10. Unverzügliche Meldung von Datenschutzverletzungen an die/den Verantwortliche:n (§9).
11. Erklärung, dass die Verarbeitung in der EU/im EWR stattfindet (§6).
12. Ansprechpartner:innen auf beiden Seiten; Aufsichtsbehörde jeder Seite.

### 4a. TOM-Anlage (Art. 32) – aktueller Stand

| Maßnahme | Stand heute |
|---|---|
| Mandantentrennung | Postgres-Datenbank pro Mandant, Keycloak-Realm pro Mandant, Secret-Dateien pro Mandant; die Control Plane hält nur Konfiguration und Secret-*Referenzen* |
| Verschlüsselung bei der Übertragung | TLS wird am Reverse Proxy mit Let's-Encrypt-Zertifikaten terminiert; interner Verkehr läuft in privaten Container-Netzwerken |
| Backup-Verschlüsselung / Crypto-Shred | Backup-Schlüssel pro Mandant nach der Regel „genau eine physische Kopie“, sodass seine Vernichtung jedes Backup dieses Mandanten entwertet |
| Verschlüsselung im Ruhezustand (Datenträger) | `TBD`, abhängig vom netcup-Produkt |
| Zugriffskontrolle | Keycloak mit erzwungener 2FA / Step-up für erhöhte Aktionen; Zugriffsrichtlinie auf Routenebene |
| Manipulationsevidenter Audit-Trail | Hash-Kette im `audit_log` mit periodischem Verifier; **nur Erkennung**, eine gebrochene Kette hält die Anwendung nicht an |
| Pseudonymisierung | IP-Pseudonymisierung mit täglicher Schlüsselrotation in der Log-Pipeline |
| Integrität des Deployments | Per Digest fixierte Images, Push-basiertes Deployment aus der CI über SSH, keine dauerhaft hinterlegten Registry-Zugangsdaten auf dem Host, keine Builds auf dem Produktionshost |
| Verfügbarkeit | **Einzelner Host, keine Hochverfügbarkeit, kein Failover.** Im AVV klar so benennen; keine Ausfallsicherheit andeuten, die das Setup nicht hat |
| Backup und Wiederherstellung | Per Entscheidung zurückgestellt, bis es schützenswerte Daten gibt; die Schwelle ist *der erste real eingetragene Name*, und an dieser Schwelle ist eine nachgewiesene Wiederherstellung erforderlich. **Zum Zeitpunkt der Erstellung offen.** |
| Absicherung des Mailwegs | Transport `stalwart`: selbst betriebener Stack mit eigenem Daten-Volume und eigenem Netzwerk, eingeschränkte Submission-Ports, SMTP AUTH für jede Einlieferung verpflichtend, einschließlich der eigenen der Plattform, SPF/DKIM/DMARC/MTA-STS. Transport `relay`: authentifizierte Einlieferung beim Relay über STARTTLS oder implizites TLS, das Relay-Passwort nur als Secret-Datei mit Modus 0600 gehalten (nie in einem Env-Wert), SPF/DKIM/DMARC an einer zugestellten Testnachricht geprüft |
| Physische Sicherheit | Rechenzentrum von netcup; die Betreiber:in erbt sie und muss auf die TOM von netcup verweisen |

## 5. Unterauftragsverarbeiter

| Partei | Funktion | Status |
|---|---|---|
| **netcup GmbH** (Deutschland) | Server-Hosting, physische Infrastruktur | Unterauftragsverarbeiter. AVV wird von netcup angeboten; **nicht abgeschlossen, `TBD` vor dem ersten realen Rat** |
| **INWX** (Deutschland) | Registrar und autoritatives DNS | Infrastruktur-Lieferant. Verarbeitet die eigenen Domain-Kontaktdaten der Betreiber:in und Metadaten von DNS-Anfragen, keine Mandanteninhalte. Per Entscheidung existiert kein API-Credential |
| **Let's Encrypt / ISRG** (USA) | Ausstellung von Zertifikaten | Kein Auftragsverarbeiter für Mandanteninhalte. Zu beachten: Jeder Mandanten-Hostname wird in den Certificate-Transparency-Logs öffentlich, was offenlegt, dass ein bestimmter Rat die Plattform nutzt; beim Onboarding offenlegen |
| **Mail-Relay** | Ausgehende Plattform-Mail (Keycloak, Alert- und Systemmail), wenn der Mail-Transport zur Deploy-Zeit `MAIL_TRANSPORT=relay` ist | **Abhängig vom Transport, pro Deployment gewählt.** `stalwart` (schlanker selbst betriebener Server): keiner, ausgehende Mail verlässt den eigenen Host der Plattform direkt, und es gibt keinen Mail-Unterauftragsverarbeiter. `relay`: Der Relay-Anbieter (Google-Workspace-SMTP-Relay) ist **Unterauftragsverarbeiter für Plattform-Mail** und muss aufgeführt, durch einen AVV abgedeckt und **vor dem ersten Deployment, das ihn nutzt, der/dem Datenschutzbeauftragten gemeldet** werden; er sieht Absender, Empfänger und Inhalt der Plattform-Mail (Login-, Passwort-Reset- und Alert-Nachrichten) und signiert sie mit seinem eigenen DKIM. Er ist kein Auftragsverarbeiter für Mandanteninhalte: Mail für einen Mandanten nutzt das eigene SMTP-Profil des Mandanten. **Offen: Entscheidung der/des Datenschutzbeauftragten und AVV nicht abgeschlossen.** |
| **Eigener SMTP-Provider des Mandanten** | Versand im Auftrag eines Rats | Auftragsverarbeiter *des Mandanten*, vom Mandanten beauftragt. Räte behalten ihre eigene Mail; die Plattform gibt einem Mandanten nie ein Postfach und empfängt keine Mail des Mandanten |
| **Offsite-Backup-Ziel** | Offsite-Kopien | **`TBD`.** Was auch immer gewählt wird, wird Unterauftragsverarbeiter und muss aufgeführt und durch einen AVV abgedeckt sein, bevor Daten des ersten realen Rats existieren |
| **GitHub (Microsoft)** | Quellcode, Container-Registry, CI, Deploy-Trigger | Nicht dazu vorgesehen, personenbezogene Daten von Räten zu verarbeiten. Betriebsregel: **keine personenbezogenen Daten von Räten in Issues, Logs oder CI-Artefakten** |

Weder ein CDN noch ein Analyse-Anbieter liegt im Pfad; der frühere Edge-Anbieter wurde
vollständig entfernt.

## 6. Übermittlung in Drittländer (Drittlandtransfer)

**Beabsichtigte Antwort: keine.** Alle Mandantendaten – Datenbanken, Dateien, Chat, Backups
(sobald das Offsite-Ziel gewählt ist und wenn es in der EU liegt) und Mail – liegen auf
einem Server in Deutschland. Punkte, die zu prüfen statt anzunehmen sind:

- Die Veröffentlichung in Certificate Transparency (von US-Stellen betriebene Logs) legt
  Hostnamen offen, keine Inhalte.
- Bei `MAIL_TRANSPORT=relay` läuft Plattform-Mail (nicht Mandanteninhalte) über die
  Infrastruktur des Relay-Anbieters. Ob das eine Übermittlung in ein Drittland ist, hängt
  vom Verarbeitungsort des Anbieters und vom AVV ab; die/der Datenschutzbeauftragte
  entscheidet, bevor dieser Transport genutzt wird.
- Liegt das Offsite-Backup-Ziel nicht in der EU/im EWR, begründet diese Entscheidung eine
  Übermittlung und braucht eine Absicherung nach Art. 44 ff.; ein EU-Ziel bevorzugen und
  die Frage damit schließen.
- Zustellbarkeitsprogramme (Microsoft SNDS, Google Postmaster Tools) sind für den selbst
  betriebenen Mailweg geplant. Vor der Anmeldung bestätigen, dass sie nur aggregierte
  IP-Reputationsdaten erhalten; sind Daten auf Empfängerebene beteiligt, ist das eine
  Übermittlung.

## 7. Löschung (Art. 17) und ihre Abbildung im Lebenszyklus

Zwei verschiedene Wege, die oft verwechselt werden:

**Löschung einzelner Nutzer:innen innerhalb eines laufenden Mandanten** ist der eigene
Vorgang des Rats in seiner eigenen Installation (hartes Löschen des Benutzerkontos, Entfernen aus
den Subsystemen, Pseudonymisierung historischer Rollenzuweisungen). Gesetzliche
Aufbewahrungspflichten haben Vorrang, wo sie gelten: Finanzunterlagen nach § 257 HGB /
§ 147 AO werden für die Dauer der Aufbewahrungsfrist *eingeschränkt* (Art. 18) statt
gelöscht, nach Art. 17 Abs. 3 lit. b DSGVO.

**Löschung eines ganzen Mandanten** ist die Pflicht der Betreiber:in bei Vertragsende und
läuft über `tenant-provision … delete <slug>` (`docs/runbooks/tenant-lifecycle.md`):

1. `status='deleting'` vor allem Destruktiven, damit ein unterbrochener Lauf sichtbar und
   fortsetzbar ist.
2. **Zuerst Crypto-Shred:** den Backup-Schlüssel des Mandanten und seine aktiven
   Credential-Dateien vernichten. Das entwertet in einem Schritt jedes Backup, das dieser
   Mandant je geschrieben hat.
3. Die Data-Plane-Datenbank und -Rolle des Mandanten löschen.
4. Den Keycloak-Realm löschen.
5. Den Slug als Tombstone markieren (`status='deleted'`); die Kennung ist für immer
   reserviert, sodass sie nie wieder auf Restdaten provisioniert werden kann.

**Bekannte Defekte, die behoben sein müssen, bevor man sich bei einem echten Antrag nach
Art. 17 darauf verlassen kann** (verfolgt als Aufgabe **T15** des netcup-Plans, „make tenant
erasure fail closed“):

- Die Shreds pro Modul werden **stillschweigend übersprungen**, wenn die Datenbank-URLs der
  Module in dem Prozess nicht vorhanden sind, der das Löschen ausführt – das ist die aktive
  Konfiguration. Der Lauf setzt trotzdem den Tombstone und meldet Erfolg.
- **Die Module `finance`, `board` und `vault` werden vom Löschpfad überhaupt nicht
  erfasst**, und `finance` und `vault` halten die sensibelsten Daten pro Mandant.
- Weil der Tombstone endgültig ist und die Wiederverwendung von Slugs verboten ist, bleibt
  bei einem Fail-open kein unterstützter Pfad, der die übrig gebliebenen Daten je wieder
  aufgreift.
- Ein übersprungener Shred wird derzeit nirgends festgehalten.

Die Abnahmebedingung von T15 ist, dass das Löschen **mit einem Exit-Code ungleich null endet
und den Mandanten auf `deleting` belässt**, statt Abschluss zu melden. Solange das nicht
umgesetzt ist, wäre eine Löschzusage gegenüber einem Rat unwahr.

**Rest, der konstruktionsbedingt bleibt:** Die geteilten Subsysteme Nextcloud und Matrix
können vom Löschpfad nicht abgebaut werden; er markiert sie im Provisioning-Ledger, und die
Betreiber:in muss den Gruppenordner samt Speicher von Hand entfernen sowie Räume
deaktivieren und Medien bereinigen. Der Crypto-Shred erfasst sie nicht; sie sind deshalb ein
eigener Schritt zum Abschluss der Löschung.

**Backup-Ausnahme, die in den AVV gehört:** Ein einzelner Löschantrag wirkt sich auf
Backups erst im eigenen Rotationszyklus des Backups aus. Die Löschung auf Mandantenebene
erfolgt sofort durch den Crypto-Shred; die Löschung einzelner Nutzer:innen nicht.

## 8. Aufbewahrung (Art. 5 Abs. 1 lit. e DSGVO)

Im Code durchgesetzt und so begrenzt, dass eine unbedachte Konfigurationsänderung sie nicht
verlängern kann (`docs/compliance.md`):

| Kategorie | Standard | Harte Obergrenze | Grundlage |
|---|---|---|---|
| Zugriffslogs | 14 d | 29 d | Obergrenze der Betreiber:in 30 d [D R29-I6]; Art. 5 Abs. 1 lit. e DSGVO |
| Anwendungs-Logs | 28 d | 29 d | wie oben; Art. 6 Abs. 1 lit. f DSGVO |
| Sicherheits-Logs (Log-Store) | 27 d | 29 d | wie oben; das Fenster des Log-Stores, nicht der Tabelle `audit_log` (eine Governance-Aufzeichnung, RC-GOV-CHAIN, von keinem Timer gelöscht) |
| Sicherheits-Logs ohne PII | 27 d | 30 d | wie oben, PII-freie Ausnahme |
| Newsletter-Versand-Tokens | Ablauf nach 7 d, Sammelbereinigung nach 90 d | — | Art. 5 Abs. 1 lit. e DSGVO |
| Backup-Aufbewahrung | Untergrenze 7 d | — | Verfügbarkeit |

Obergrenze der Betreiber:in 30 d [D R29-I6]: Keine Angabe in dieser Tabelle überschreitet
sie. Keine der vier Log-Stufen hat einen Purge-Consumer in der Anwendung (TASK-033-a): Sie
sind Konfiguration und die Fenster des Log-Stores. Die Tabelle `audit_log` ist eine
Governance-Aufzeichnung, wird aufbewahrt und ist nur anfügbar (append-only). Edge- und
Identity-Provider-Logs werden unabhängig davon begrenzt (`docs/log-retention-policy.md`).

Ein deutschsprachiges **Löschkonzept** wird bei Bedarf aus der aktiven Konfiguration erzeugt,
sodass es nicht von den tatsächlich durchgesetzten Fenstern abweichen kann. Es wird aus den
Konfigurationsfeldern `compliance.*` gespeist (`controller_name`, `controller_address`,
`dpo_name`, `dpo_email`, `purpose_description`), die jede Installation – gehosteter Mandant
ebenso wie Selbstbetreiber:in – ausfüllen muss.

## 9. Ablauf bei Datenschutzverletzungen (Art. 33 / 34)

1. **Eingang:** GitHub Private Vulnerability Reporting und `security@gremion.de`. Eine
   Schwachstellenmeldung ist nicht automatisch eine Verletzung des Schutzes
   personenbezogener Daten (Datenschutzverletzung); die Triage entscheidet.
2. **Bewertung:** welche Mandanten, welche Datenkategorien, Eintrittswahrscheinlichkeit und
   Schwere des Risikos.
3. **Als Auftragsverarbeiter:** jeden betroffenen Rat **unverzüglich** (Art. 33 Abs. 2)
   benachrichtigen, Ziel 24 Stunden ab Kenntnis, mit dem, was bekannt ist, was unbekannt ist
   und welche Maßnahmen ergriffen wurden. Der Rat entscheidet als Verantwortliche:r über die
   72-Stunden-Meldung an seine Aufsichtsbehörde.
4. **Als Verantwortliche:r** (Plattform-Konten, Logs, Plattform-Mail): Die Betreiber:in
   meldet an die eigene Aufsichtsbehörde innerhalb von 72 Stunden, wo die Risikoschwelle
   erreicht ist.
5. **Art. 34:** Die Benachrichtigung betroffener Personen ist Pflicht der/des
   Verantwortlichen; die Betreiber:in unterstützt den Rat mit Fakten und Formulierungen.
6. **Register:** Jeder Vorfall kommt in ein internes Register für Datenschutzverletzungen,
   unabhängig davon, ob er meldepflichtig war.

## 10. Verzeichnisse von Verarbeitungstätigkeiten nach Art. 30 (VVT) – Gerüst

**Art. 30 Abs. 1 – Betreiber:in als Verantwortliche:r.** Ein Eintrag je
Verarbeitungstätigkeit: Name und Kontaktdaten der/des Verantwortlichen (und der/des
Datenschutzbeauftragten, falls eine:r erforderlich ist); Zweck; Kategorien betroffener
Personen; Kategorien personenbezogener Daten; Kategorien von Empfängern; Übermittlungen in
Drittländer (keine beabsichtigt); Löschfristen; allgemeine Beschreibung der TOM. Zu
erfassende Tätigkeiten: Plattform-Konten und Vertragsverwaltung; die Marketing-Website; die
eigene Mail der Plattform; Infrastruktur- und Sicherheitsprotokollierung;
Support-Korrespondenz; Betrieb von Quell-Repository und CI.

**Art. 30 Abs. 2 – Betreiber:in als Auftragsverarbeiter.** Ein Eintrag je Verantwortliche:n
(je Rat): Name und Kontaktdaten der Betreiber:in sowie der Verantwortlichen, für die sie
tätig ist; die Kategorien der im Auftrag dieser Verantwortlichen durchgeführten
Verarbeitungen; Übermittlungen in Drittländer (keine beabsichtigt); allgemeine Beschreibung
der TOM; dazu, für die eigene Akte der Betreiber:in, die für diese:n Verantwortliche:n
eingesetzten Unterauftragsverarbeiter.

Beide Verzeichnisse sind heute leer, weil es weder einen Rat noch reale Daten gibt.

## 11. Pflichten der Selbstbetreiber:innen

Ein Rat, der Gremion selbst betreibt, ist **alleinige:r Verantwortliche:r** und hat im
Gremion-Projekt keinen Auftragsverarbeiter. Konkret muss er:

- die Konfiguration `compliance.*` ausfüllen (Name und Adresse der/des Verantwortlichen,
  gegebenenfalls Datenschutzbeauftragte:r, Zweckbeschreibung); sie speist das erzeugte
  Löschkonzept und die rechtlichen Seiten.
- Aufbewahrungsfenster innerhalb der durchgesetzten Obergrenzen setzen und prüfen, dass die
  eigene Log-Rotation dazu passt.
- einen eigenen AVV mit **seinem** Hoster abschließen sowie mit jedem Dritten, den er
  konfiguriert (sein SMTP-Provider, eine externe Nextcloud, eine externe Helios-Instanz).
- prüfen, ob er eine:n Datenschutzbeauftragte:n benennen muss (in Deutschland § 38 BDSG: ab
  20 Personen, die ständig mit der automatisierten Verarbeitung beschäftigt sind, und
  unabhängig von der Personenzahl bei Verarbeitungen, die eine DSFA erfordern).
- prüfen, ob eine Datenschutz-Folgenabschätzung (DSFA, Art. 35) erforderlich ist;
  elektronische Stimmabgabe und personalnahe Datensätze sind die wahrscheinlichen Auslöser.
- den Löschpfad *einschließlich* des manuellen Nextcloud- und Matrix-Rests durchführen und
  den oben genannten Defekt T15 beachten: Mit dem aktuellen Code kann das Löschen eines
  ganzen Mandanten Erfolg melden, während Moduldaten erhalten bleiben.
- beachten, dass die Software unter AGPL-3.0-only **ohne Gewährleistung** bereitgestellt
  wird. Weder die Lizenz noch dieses Dokument ist eine Compliance-Garantie, und das
  Quellcode-Angebot nach AGPL § 13 ist eine Lizenzpflicht, keine datenschutzrechtliche.

## 12. Offene Fragen – zu klären, sobald der Rat für den Pilotbetrieb benannt ist

- Die Rechtsform, der rechtliche Name und die Adresse der Betreiber:in für den
  Unterschriftsblock des AVV.
- Ob der Rat eine öffentliche Stelle ist – wenn ja, gelten das Datenschutzgesetz und die
  Aufsichtsbehörde des Landes, und der AVV muss die Anforderungen des Landes abbilden – und
  **wer unterzeichnen kann** (die Studierendenschaft selbst oder die Hochschule).
- Ob eine der beiden Seiten eine:n Datenschutzbeauftragte:n hat oder braucht.
- Ob für den Umfang des Piloten eine DSFA erforderlich ist (insbesondere bei Wahlen).
- Das Offsite-Backup-Ziel und eine nachgewiesene Wiederherstellung; die Schwelle ist der
  erste real eingetragene Name, nicht der Go-live.
- Ob der Pilot neben dem Demo-Mandanten läuft, was jede Frage zu den geteilten Subsystemen
  in §3 tatsächlich aktiviert.
- Die Matrix-Entscheidung aus §3: gemeinsamer Homeserver mit Plattform-`server_name` oder
  ein Homeserver pro Mandant.
- Das eigene SMTP-Profil des Mandanten und die Rechtstexte pro Mandant (Impressum,
  Datenschutzerklärung).
- Löschfrist nach Vertragsende und der Nachweis, den die Betreiber:in dafür liefert.

## 13. Ehrliche Grenzen dieses Dokuments

- Dieses Repository ist der **Kernel**. Der gehostete Dienst wird separat betrieben, und
  einige der Codepfade, von denen dieses Dokument abhängt – namentlich die Löschendpunkte
  pro Modul –, liegen außerhalb des Kernels. Der Kernel liegt in diesem Bereich hinter dem
  Produkt zurück.
- Der Kernel enthält nicht das vollständige Produktschema (hier 22 Migrationen gegenüber 58
  im Produkt), und die hier mitgelieferten Referenz-Web-Shells sind nicht normativ.
- Die in §7 beschriebene Löschgarantie wird derzeit **nicht erfüllt**; der Defekt ist
  benannt, nicht versteckt.
- Es existiert noch kein AVV, keine Vereinbarung nach Art. 26, kein Verzeichnis nach Art. 30
  und keine TOM-Anlage. Dieses Dokument existiert, damit die späteren Dokumente auf Grundlage einer
  festgelegten Position entstehen und nicht improvisiert werden.
