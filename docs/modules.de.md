<!-- i18n-sync: source=modules.md sha256=4c6163c557841f71f5c60ce5d1cfae32d847a45128cf685dac30d46f4530245f -->
[English](./modules.md) | **Deutsch**

# Unterstützte Module

Diese Seite listet die Module, die in diesem Tree unter [`modules/`](../modules) liegen, wofür
sie jeweils da sind, ob sie unterstützt werden und welche externen Dienste sie benötigen.
Jedes Modulverzeichnis enthält ein eigenes `README.md` mit Routen, Migrationen, Konfiguration
und Tests.

Ein Modul dockt über das Modul-SDK ([add-a-module.md](./playbooks/add-a-module.md), englisch)
an den Governance-Kernel an; der Kernel baut und startet ohne jedes davon. Alles in dieser
Tabelle ist aus den Dateien der Modulverzeichnisse (`module.json`, dem Manifest unter
`app/lib/modules/manifests/`, `migrations/`, den Route-Dateien) und aus `modules/disabled.json`
abgeleitet. Eine Aussage, die der Code nicht entscheidet, ist im README des Moduls als solche
gekennzeichnet, statt geraten zu werden.

`scripts/check-module-docs.mjs` (Tests: `scripts/check-module-docs.test.mjs`) schlägt fehl,
wenn ein Verzeichnis unter `modules/` kein `README.md` hat, wenn es in der folgenden Tabelle
fehlt oder wenn der Status „standardmäßig deaktiviert“ hier nicht mit `modules/disabled.json`
übereinstimmt.

## Statuswerte

| Status | Bedeutung |
|---|---|
| unterstützt | Im Standard-Build enthalten (nicht in `modules/disabled.json` aufgeführt); die App-Hälfte und/oder der Leaf-Service liegen in diesem Tree. Es lässt sich pro Kunde (Mandant) ein- oder ausschalten. |
| standardmäßig deaktiviert | In `modules/disabled.json` aufgeführt: wird mit dem Workspace installiert und typgeprüft, ist aber vom Standard-Build und vom Standard-Deploy ausgeschlossen. |
| nur Manifest | Das Verzeichnis enthält `module.json` (und eine `package.json`) und sonst nichts; es gibt noch keinen lauffähigen Code. |

„Unterstützt“ beschreibt, was der Tree enthält und testet. Es sagt nichts darüber, was das
laufende System eines bestimmten Kunden ausliefert; welche Module ein Pilotkunde anfangs
bekommt und was nicht behauptet wird, steht in
[pilot/module-defaults.de.md](./pilot/module-defaults.de.md).

## Module

| Modul | Zweck | Status | Benötigte externe Dienste | README |
|---|---|---|---|---|
| `board` | Aufgabenboard (Stacks und Karten) je Organisationseinheit; Aktionspunkte aus Protokollen lassen sich in Karten umwandeln. | unterstützt | außer dem Kernel nichts; ein eigener PostgreSQL-Server (Compose-Profil `board`) | [modules/board/README.de.md](../modules/board/README.de.md) |
| `calendar` | Termine, Terminarten, Wiederholungen und Kalendereinstellungen der Gremien; überträgt Termine an CalDAV und leitet Änderungsereignisse über NATS weiter. | unterstützt | Nextcloud (CalDAV), NATS, ein eigener PostgreSQL-Server (Profil `calendar`) | [modules/calendar/README.de.md](../modules/calendar/README.de.md) |
| `content` | Content-Engine: Beiträge mit den Kanälen E-Mail, Website (Portal) und Instagram, Mailinglisten, zeitgesteuerte Veröffentlichung. | unterstützt | NATS, SMTP über den Kernel, Instagram Graph API (optionaler Kanal), ein eigener PostgreSQL-Server (Profil `content`) | [modules/content/README.de.md](../modules/content/README.de.md) |
| `elections` | Optionale Gremienwahlen über Helios, mit einem dauerhaften Hinweis, dass das Modul keine satzungsgemäße Wahl ersetzt. Nur App-Hälfte; kein Leaf-Service. | unterstützt | Helios (Wahlserver) | [modules/elections/README.de.md](../modules/elections/README.de.md) |
| `files` | Dokumentenbrowser über Nextcloud-WebDAV; Bearbeitung im Browser über Collabora. | unterstützt | Nextcloud, Collabora | [modules/files/README.de.md](../modules/files/README.de.md) |
| `finance` | Haushaltspläne, Projekte, Ausgaben, Freigaben, Buchungen, Bankkonten, SEPA-Export, FinTS- und CSV-Import. Nur Leaf-Service; die App-Hälfte liegt nicht in diesem Tree. | standardmäßig deaktiviert | NATS, Bankzugang über FinTS (optional), Nextcloud (optionale Belegablage), ein eigener PostgreSQL-Server (Profil `finance`) | [modules/finance/README.de.md](../modules/finance/README.de.md) |
| `handover` | Übergabe der Unterlagen einer Organisation an ihre Nachfolger:innen. Platzhalter: nur `module.json` und `package.json`. | nur Manifest | noch keine | [modules/handover/README.de.md](../modules/handover/README.de.md) |
| `messaging` | Chaträume und Videoanrufe: ein dünner Proxy zum Matrix-Homeserver (Synapse) und zu LiveKit, dazu das Synapse-Image und seine Konfiguration. | unterstützt | Matrix/Synapse (hier mitgeliefert, Profil `messaging`), LiveKit, Element Call, Keycloak; Firebase Cloud Messaging für Push (optional) | [modules/messaging/README.de.md](../modules/messaging/README.de.md) |
| `publishing` | Newsletter: Listen, Entwürfe, Zeitplan und Versand, Abmeldung. Seine Manifest-ID ist `newsletter`. | unterstützt | NATS, SMTP über den Kernel, Collabora (Entwurfskonvertierung und -bearbeitung), ein eigener PostgreSQL-Server (Compose-Profil `newsletter`) | [modules/publishing/README.de.md](../modules/publishing/README.de.md) |
| `vault` | Tresor für Geheimnisse je Organisationseinheit mit Protokollierung jeder Offenlegung, dazu eine Launcher-Seite für ein extern betriebenes Vaultwarden. | standardmäßig deaktiviert | Vaultwarden (nur Launcher-Seite), ein eigener PostgreSQL-Server (Profil `vault`) | [modules/vault/README.de.md](../modules/vault/README.de.md) |
| `votes` | Offene Umfragen und die kombinierte Abstimmungsliste (Umfragen plus Helios-Abstimmungen). Zustandsloser Leaf-Service. | unterstützt | Nextcloud Polls, Helios (optional, für Abstimmungen) | [modules/votes/README.de.md](../modules/votes/README.de.md) |

Hinweise zu den Namen:

- Der Verzeichnisname eines Moduls, seine `module.json`-ID und seine Manifest-ID sind nicht
  immer dieselben. `publishing` (Verzeichnis und `module.json`-ID) registriert die Manifest-ID
  `newsletter`; `messaging` registriert `messages`. Der Schlüssel `config.modules` pro Mandant
  ist die Manifest-ID.
- Das Compose-Profil, das den PostgreSQL-Server eines Moduls startet, verwendet den
  Profilnamen aus `docker-compose.yml` (`newsletter` für publishing, `messaging` für
  messaging).

## Ein Modul ein- oder ausschalten

Es gibt drei getrennte Schalter; im README jedes Moduls steht, welche davon zutreffen.

1. **Build.** `modules/disabled.json` nimmt ein Modul aus dem Standard-Build und dem
   Standard-Deploy. `gremion-ui/scripts/interim-module-overlay.mjs` kopiert die `app/`-Hälfte
   jedes aktivierten Moduls nach `gremion-ui/src/` und weist im Build-Modus ein deaktiviertes
   Modul ab.
2. **Pro Kunde.** Ein Kunde wird durch eine Provisioning-Anfrage aus dem Control Panel
   angelegt, und Module werden für ihn über die Anfragen `enable_module` und `disable_module`
   aktiviert oder deaktiviert, beschrieben in
   [runbooks/tenant-lifecycle.md](./runbooks/tenant-lifecycle.md) (englisch). Ein Modul, das
   in `modules/disabled.json` steht, lässt sich auf diesem Weg nicht aktivieren. Ein Modul
   kann auch von der Gremiumsverwaltung unter Einstellungen > Module **eingeschaltet** werden
   (`calendar`, `elections` und `votes`; mit frischer Zwei-Faktor-Prüfung, ohne Freigabe durch
   den Betreiber; siehe „Module self-service by the council“ im selben Runbook). Dieselben
   Module kann die Gremiumsverwaltung dort auch **ausschalten**; was das bewirkt, steht im
   nächsten Abschnitt.
3. **Einstellung pro Instanz.** `config.modules.<manifest id> = false` lässt die Routen des
   Moduls mit der Oberfläche für deaktivierte Module antworten und blendet seinen
   Navigationseintrag aus; die Daten bleiben erhalten
   ([playbooks/add-a-module.md](./playbooks/add-a-module.md), Abschnitt zur Abwahl; englisch).

### Ein Modul ausschalten: die 30-Tage-Karenz

Das Ausschalten eines Moduls pro Kunde zerstört 30 Tage lang nichts (die „Karenz“). Die
Datenbank des Moduls wird exportiert und dann gesperrt, nicht gelöscht; Fristen in Nextcloud
Polls und in Helios werden eingefroren; Chat-Räume werden archiviert; das Dateimodul verliert
nur seine Bindung, und keine Datei wird gelöscht. Unterlagen, die aufbewahrt werden müssen,
werden im Moment des Ausschaltens als schreibgeschützte Kopien versiegelt. Die Inhaberinnen
und Inhaber der Rollen `council-admin` und `vorstand` erhalten beim Ausschalten eine
Info-Mail und Erinnerungen 7 Tage und 1 Tag vor dem Ende; die Mails nennen nie die Person,
die ausgeschaltet hat.

Schaltet man das Modul innerhalb der 30 Tage wieder ein, wird alles wiederhergestellt: Die
Datenbank wird entsperrt, eingefrorene Fristen laufen mit der verbleibenden Zeit weiter, und
Räume werden wieder aus dem Archiv geholt. Am Tag 30 löscht ein geplanter Job den Rest (die
gesperrte Datenbank und ihren Export, Umfragen und Chat-Räume), ausgenommen Chat-Räume mit
Bezug zu einer Sitzung und die versiegelten Kopien. Der Lösch-Schritt des Jobs wird
ausgeschaltet ausgeliefert und meldet nur, was er löschen würde, bis der Betreiber ihn
einschaltet. Nach Tag 30 beginnt ein erneutes Einschalten von vorn und zeigt die versiegelten
Kopien des früheren Zeitraums schreibgeschützt an.

Die Einstellungsseite zeigt die verbleibenden Tage, eine Schaltfläche zum Wiederherstellen,
jedes Problem des Ausschaltens und die versiegelten Kopien zum Herunterladen für die Rollen,
die sie lesen dürfen (`council-admin`, `vorstand`, `finance`, `auditor`, `it-admin`). Das
Vorgehen des Betreibers steht in
[runbooks/tenant-lifecycle.md](./runbooks/tenant-lifecycle.md) (englisch), Abschnitt „Module
Karenz (30 days)“.

Ein Leaf-Service ist ein separater Container, der aus `modules/<directory>/Dockerfile` mit dem
Repository-Root als Build-Kontext gebaut wird. Die Kernel-App erreicht ihn, wenn die Variable
`*_BACKEND` des Moduls `service` ist und `*_SERVICE_URL` auf ihn zeigt; jeder Leaf-Aufruf
trägt das gemeinsame Secret in `x-internal-auth` und den Mandanten in `x-tenant-id` und
`x-tenant-slug`.
