<!-- i18n-sync: source=about-gremion.md sha256=8d330e7cdcef1cd2f8fd141273ad300504b3c5bde2c768a623438bf4c6784b8c -->
[English](./about-gremion.md) | **Deutsch**

# Über Gremion

> **Status:** Öffentlich, AGPL-3.0-only, Version 0.1.0. Es gibt noch keine stabile Release-Linie: Korrekturen landen auf `main`, Konsument:innen fixieren einen SHA. Dieses Dokument ist die maßgebliche Quelle des Kernels dafür, was Gremion ist und wie es geregelt ist; der übrige Teil von `docs/` stammt teils aus dem Referenz-Deployment StuRaOS und wird noch überarbeitet (siehe [INDEX.md](./INDEX.md), englisch).
>
> **Interner Alias.** Während der Entwicklung wurde an diesem Projekt unter dem internen Namen **Civitas** gearbeitet. Dieser Name wird nach außen nicht verwendet und ist nicht der Name des Projekts; er überlebt nur in der Commit-Historie und im Kopfkommentar von vier angewendeten Migrationen, die in [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) (englisch) als Namensschulden geführt werden. Das Projekt heißt **Gremion**. Der Alias wird hier genannt und, mit den Gründen, warum er aufgegeben wurde, in [`TRADEMARK.md`](./TRADEMARK.md) (englisch); an keiner anderen Stelle der Dokumentation erscheint er als Name dieses Projekts.

## Was Gremion ist

**Gremion** ist ein offener, selbst betreibbarer **Kernel für digitale Governance** für Räte, Studierendenparlamente (*Studierendenräte*), Vereine und ähnliche beratende Gremien. Er liefert die Grundlage, die jedes mandatierte Governance-Gremium braucht: Identität, Mandantenfähigkeit, ein Organisations- und Gremienmodell, Protokolle und Beschlüsse mit hash-verkettetem Audit-Trail sowie eine Entscheidungs-Engine, die das Quorum berücksichtigt. Darauf setzt ein **Modul-SDK** auf, in das sich optionale Funktionen einklinken, ohne dass der Kernel jemals von ihnen abhängt.

Der verteidigbare, neuartige Kern von Gremion ist die Schicht für **bindende Entscheidungen und geprüfte Mittelbindung**. Civic-Tech-Plattformen wie Decidim, CONSUL und Pol.is setzen nur die *konsultative* Hälfte um und verlagern die bindende Entscheidung und das Geld *aus der Software heraus*. Gremion ist das Gegenstück: Die bindende Entscheidung und die geprüfte Bindung von Mitteln sind als vollwertige Bestandteile *in* der Software abgebildet.

## Was es leistet

- **Verallgemeinert eine Vertikale zu einer wiederverwendbaren Grundlage.** Gremion hebt die Governance-Ontologie, die im StuRaOS-Schema implizit steckte (Gremien, Mandate, Beschlüsse, Finanzen nach dem Vier-Augen-Prinzip, Audit), in ein universelles Modell. Dadurch lässt sich jedes mandatierte Governance-Gremium aus einer Codebasis aufsetzen, statt eine deutsche Studierendenrat-Anwendung zu forken.
- **Hält die Manipulationssicherheit unabschaltbar.** Die Governance-Invarianten (hash-verkettetes Audit, Durchsetzung von Quorum und Schwellenwerten, Mandantentrennung) liegen im Kernel als Hooks hinter keinem Feature-Flag. Kein Deployment-Schalter kann einen Governance-Akt fälschen, verbergen oder delegitimieren.
- **Startet eigenständig.** Der Kernel **baut und startet ohne ein geschlossenes Modul**: Er ist als Ganzes für sich allein nutzbar und förderfähig.
- **Tragfähigkeit ohne Relizenzierungsrisiko.** Der Kern ist und bleibt AGPL-3.0-only. Optionales Hosting und Support finanzieren die Arbeit, nach demselben Modell wie bei Decidim, und keine Finanzierungsvereinbarung kann den Kern relizenzieren (siehe [`../CONTRIBUTING.md`](../CONTRIBUTING.md), englisch).

## Für wen und wo einsetzbar

Gremion richtet sich an **personenbasierte, mandatierte Governance-Gremien**, also Gremien mit gewählten oder berufenen Mitgliedern, Anträgen, Beschlüssen und geprüfter Mittelbindung:

- Studierendenräte
- Kommunale Vertretungen und Gemeinderäte
- NGOs, Genossenschaften und Vereine

Jedes Deployment ist eine **Vertikale**, die Konfiguration, i18n, Seed-Daten und Theme über Kernel und Governance-Modul legt:

- **StuRaOS**: das erste Referenz-Deployment, eine deutsche Studierendenrat-Instanz (das Preset aus gewählter Versammlung, Mehrheitsbeschluss und Vier-Augen-Finanzen). Es liegt in einem privaten Repository; das Deployment, auf dem es lief, wurde stillgelegt.
- **Musterstadt**: eine kommunale *Gemeinderat*-Vertikale (Finanzen aus, kommunales Vokabular, drei *Fraktionen*) und der Nachweis, dass Gremion ein wiederverwendbares Framework ist und nicht StuRaOS mit Mandantenfähigkeit.
- Ein generischer **Demo**-Mandant.

**Im Umfang:** personenbasierte Gremien, die als strikter Baum modelliert sind. **Nicht im Umfang** (eine eigene Schwester-Abstraktionshöhe): der Quadrant aus tokengewichteten, selbstausführenden, in Eigentum befindlichen und souveränen Körperschaften, also DAOs, Unternehmen und souveräne Stellen.

**Harte rote Linie, für jedes Deployment und jedes Repository, öffentlich oder privat:** keine echten oder privaten Daten. Nur erfundene, generische Fixtures. Die Regel wird am aktuellen Tree durchgesetzt; siehe [`../SECURITY.md`](../SECURITY.md) (englisch), um etwas zu melden, das durchgerutscht ist.

## Architektur: das Open-Core-Modell mit drei Schichten

Gremion ist ein **verteilter modularer Monolith** in drei Schichten. Die Grenze zwischen ihnen folgt **einem einzigen Prinzip, der Abhängigkeitsrichtung:**

> **Der Kern darf nie ein Modul importieren; Module importieren den Kern.**

Als Lint-Regel umgesetzt, hält sich die Grenze selbst aufrecht. Der Klassifikationstest für jedes Stück Code:

> Kann das System ohne es nicht **starten** oder **autorisieren**, oder könnte sein Abschalten einen Governance-Akt **fälschen, verbergen oder delegitimieren**, ist es **Kernel**. Alles, ohne das ein Deployment laufen könnte, ist ein **Modul**.

| Schicht | Inhalt | Lizenz | Abwählbar? |
|-------|------|---------|---------------|
| **1. Kernel** | Domänenneutrale Grundlage + **Invarianten-Hooks** der Governance | Öffentlich, AGPL-3.0-only | Nie |
| **2. Governance** | Die Governance-Domäne als Flaggschiff, im Tree ausgeliefert, standardmäßig aktiv; architektonisch ein *Modul*, das die Kernel-Hooks aufruft | Öffentlich, AGPL-3.0-only | Nein (immer aktiv) |
| **3. Funktionsmodule** | Wahlen, Newsletter, Kalender, Dateien, Nachrichten, Aufgabenboard, Verwaltungsoberfläche für Nutzer:innen, Finanzen, Inhalte, Tresor, Übergabe | Überwiegend AGPL-3.0-only; vier sind geschlossen (siehe unten) | Ja |

Die Grenze entspricht 1:1 der Governance-Charta: Die **4 festen Invarianten sind Kernel-Hooks**; die **3 Strategie-Slots und alle Funktionen sind Module**. Der eine katastrophale, nicht umkehrbare Fehlschnitt, den es zu vermeiden gilt, wäre ein Schalter zum „Abschalten der Manipulationssicherheit“: Audit-Kette, Quorum-Durchsetzung, Authentifizierung und Identität sowie Mandantentrennung sind unverhandelbar nie abwählbar.

Vorbilder: Decidim (`decidim-core` = Nutzer:innen und Authentifizierung + Organisation und Mandantenfähigkeit + der Komponentenvertrag; Funktionen als optionale Gems; der Admin-Bereich wird immer mitgeliefert), Odoo (ein neutrales `base`, in dem alles ein Modul ist) und die mandantenfähige Identität von Azure („baue keinen eigenen IdP“).

## Der Kernel

Der Kernel wird im Tree ausgeliefert:

- **Identität und Authentifizierung**: Keycloak OIDC, ein Rollen- und Capability-Modell, Step-up-Anbindung (LoA/ACR). *users-identity* gehört zum Kernel; die Verwaltungsoberfläche für Nutzer:innen (*users-admin UI*) ist ein Modul.
- **Mandantenfähigkeit**: Datenisolation pro Mandant, der Tenant-Resolver, das Control-Plane-Register, Fleet-Migrationen.
- **Governance-Domäne** (das Governance-Modul als Flaggschiff): Gremien und Mitglieder, der Baum der Organisationseinheiten, Protokolle, *Beschlüsse*, das öffentliche Portal.
- **Governance-Invarianten** (Kernel-Hooks, hinter keinem Flag): **INV-1**, das hash-verkettete Audit-Log, und **INV-5**, die Engine für Quorum und Entscheidungsregeln; auch die Mandantentrennung ist ein Invarianten-Hook des Kernels.
- **Modul-SDK**: manifestgesteuerte Registrierung plus Laufzeit-Register und der Boundary Enforcer (siehe unten).
- **Gemeinsame Pakete**: `@gremion/db` (rein, ohne Feature-Bezüge) und `@gremion/ports` (`BrokerPort` über NATS/JetStream, `TracerPort`, Anti-Corruption-Callbacks, transaktionale Outbox plus Saga).
- **Konfiguration / Branding** und die **Admin-Shell**.

**Tatsächlich ausgelieferte Manifeste:** genau zwei. `coreManifest` (id `core`, `toggleable: false`; die minimale Kernel-Shell: Dashboard, Einstellungen, Systemstatus) und `governanceManifest` (id `governance`, `toggleable: false`, weil *der Gremion-Kernel ein Governance-Produkt ist*: Mitglieder, Gremien, Portal, Protokolle, Beschlüsse). `index.generated.ts` wird per Codegen erzeugt und durch `registry.test.ts` byteweise festgeschrieben; ein Manifest für Finanzen, Abstimmungen, Inhalte, Kalender, Dateien oder Nachrichten ist nicht vorhanden.

**Reiner Governance-Stack (7 Dienste):** `postgres`, `keycloak`, `gremion-ui`, `gremion-public`, `legal`, `vector`, `mailpit`, dazu `traefik` und `docker-socket-proxy` unter dem Profil `production` sowie `pgbouncer` / `cloudflared` / `fallback` aus `docker-compose.prod.yml`. Der `x-forwarded-host`-Resolver von Traefik ist für die Mandantenfähigkeit tragend. Das vollständige StuRaOS-Produkt bestand aus 19 Diensten.

## Governance-Charta und Invarianten

Gremion übernimmt eine **Charta der Governance-Domäne auf mittlerer Abstraktionshöhe**, das **Mandated Governance Body** (moderater Kern, mittlere Reichweite). Eine engere Höhe („Mandated Deliberative Assembly“) wurde verworfen, weil der Modus des *Gemeinderats* per Handzeichen ohne Stimmenzählung ein Universalmodell mit Zählung je Stimmberechtigten bricht; eine breitere („Accountable Authority Substrate“) wurde verworfen, weil ihre Invarianten auf den kleinsten gemeinsamen Nenner zusammenfallen, der nichts mehr beschränkt.

Das ehrliche Rückgrat sind **4 feste Invarianten + 3 Strategie-Slots** (ein adversarialer Belastungstest stufte zwei von sechs vorgeschlagenen Universalien zu Slots herab).

**Feste Invarianten:**
- **INV-1: erst erfasst, dann angenommen** (zählungsfrei): das hash-verkettete, manipulationssichere Audit-Log.
- **INV-2: begrenzter Zuständigkeitsbereich, Handeln außerhalb der Befugnis (ultra vires) ist nichtig.**
- **INV-3: Das Mandat ist eine eigenständige, beendbare Übertragung.**
- **INV-5: Bindungswirkung aus einem vorab erklärten Verfahren**, bei der Annahme geprüft: die Engine für Quorum, Schwellenwerte und Entscheidungsregeln.

*(Die Nummerierung der Charta überspringt INV-4 absichtlich.)* Die zwei **technischen** Invarianten, die im Kernel durchgesetzt werden, sind **INV-1** und **INV-5**. Beide liegen im Kernel als Hooks, die das Governance-Modul *aufruft*; die Durchsetzung liegt nie beim Modul, daher lässt sich die Manipulationssicherheit nicht abschalten.

**Strategie-Slots** (sie variieren innerhalb der Klasse zu Recht und gehören dem Governance-Modul, nicht dem Kernel):
1. **Stimmrecht (Franchise)**: gleich gezählt / Akklamation / gewichtet / liquide.
2. **Schutzmechanismus für die Mittelbindung**: vorab Vier-Augen-Prinzip / M-aus-N / Zuweisung durch die übergeordnete Ebene / nachträgliche Sanktion.
3. **Rechenschaft für das Mandat**: durch den Wahlkreis widerrufbar / zweckgebunden / ernannt.

Das **Metamodell besteht aus 7 Primitiven**: Gremium, Mandat, Stimmrecht, Entscheidungsregel, Beschluss, Schutzmechanismus für die Mittelbindung sowie Rechenschaft und Anfechtbarkeit. Jedes ist eine Verallgemeinerung einer bestehenden StuRaOS-Tabelle, sodass die Einführung keinen Schema-Umbau erfordert.

**Hinweise zur Umsetzung.** Das Quorum-Gate von INV-5 greift **bei der Annahme** (Veröffentlichung des Protokolls), nicht beim Schreiben eines Beschlussentwurfs; das Sperren von Entwürfen lieferte in der Live-Oberfläche 422. Die Entscheidungsregel wird bei der Anlage festgelegt (ein PATCH kann die erforderliche Mehrheit nicht ändern). Die Audit-Kette ist hash-verkettet, mit einem durch Advisory-Lock serialisierten `BEFORE INSERT`-Trigger und einer Prüfung `verifyAuditChain`. Ein bekanntes Restproblem ist, dass eine in sich geschlossene Kette das **Abschneiden am Ende** nicht erkennen kann (Änderungen mitten in der Kette werden erkannt); die Lösung über einen externen Anker ist als Folgearbeit in Phase 3 zurückgestellt.

**Theoretischer Anker:** Weber (legal-rationales Amt), Montesquieu (Gewaltenteilung), Prinzipal-Agent-Theorie (beendbare Delegation) und Pettit (Nicht-Beherrschung / Anfechtbarkeit), mit Ostrom als empirischem Validator. Die deutsche Parlamentspraxis ist das **Referenz-Preset, nicht der Kern**. Beschlossener Zuschnitt: nur ein striktes Baummodell für Gremien (kein polyzentrisches Modell, kein DAG; das wäre ein dokumentierter harter Fork).

Invarianten sind **später billig hinzuzufügen** (noch hängt nichts von ihnen ab) und **teuer zu lockern** (ein Breaking Change für alle Konsument:innen, die ihnen vertraut haben). Deshalb wird nur das als fest ratifiziert, was für die ganze Klasse gilt und nie gebrochen werden muss; alles andere ist ein Slot.

## Das Modul-SDK

Ein **Modul** = ein **Manifest** im Kernel (Seiten, Route-Gates, Capabilities, ein Realm-Fragment, Navigation) **+ ein optionaler Backing-Service** (Daten und aufwendige Logik). Der Kernel entdeckt Module über das SDK und **importiert keines davon namentlich**.

- **Manifestgesteuert, ohne gemeinsame Änderungen.** Die Navigation wird über `composeNavSchema(baseNavSchema, MODULE_MANIFESTS)` zusammengesetzt; `config.modules` ist ein dynamisches `Record<string, boolean>`. Ein neues abwählbares Modul braucht keine Änderung an gemeinsamen Dateien: Seitenzugriff, Route-Präfixe, Capabilities, Navigation, Realm, Konfigurationsstandard und Migrations-Nachzug sind alle am Manifest verankert.
- **Kompositionswurzeln sind Codegen-Barrels.** Prebuild-Skripte durchsuchen das Dateisystem (`manifests/*.ts`, `lib/server/*/register.server.ts`, `migrations/*.sql`), um das Modulregister, das Server-Init und das Migrationsmanifest zu erzeugen. Wer ein Modul hinzufügt oder entfernt, lässt den Codegen erneut laufen, statt Importlisten von Hand zu pflegen.
- **Laufzeit-Register-Naht.** `lib/server/modules/runtime-registry.ts` plus `register.server.ts` je Modul (geladen über das Codegen-Barrel `server-init.generated`) kehren Server-Init, Tenant-Evict, Provisioning und Dashboard-Zähler um, sodass der Kernel nie statisch ein Modul importiert.
- **Auto-Discovery ist das Scharnier des Open Core.** Das Manifest eines privaten Moduls kann nicht im öffentlichen Kernel fest verdrahtet sein, denn das würde Existenz und Gestalt des Moduls preisgeben. Deshalb liefert der Kernel das SDK plus eine Discovery-Naht, und private Module bringen ihr eigenes Manifest mit.
- **Der Boundary Enforcer.** Ein flächendeckender `boundary/kernel-clean.test.ts` geht jede Kernel-Datei durch, löst `$lib/*`- und relative Specifier zu kanonischen Pfaden auf, überspringt modul-eigene und generierte Verzeichnisse und stellt sicher, dass jeder Import eine Teilmenge einer dokumentierten ALLOW-Map ist. Dass der Test greift, ist durch einen probeweise eingeschleusten Import vom Kernel in ein Modul belegt. Die ALLOW-Menge *ist* die Liste der verbleibenden Arbeit.

Siehe das [Modul-Playbook](./playbooks/add-a-module.md) und das [Playbook zur Service-Extraktion](./playbooks/extract-a-service.md) (beide zuerst auf StuRaOS ausgerichtet übernommen und in Überarbeitung; englisch).

## Lizenzierung und Beiträge

Gremion steht **dauerhaft unter AGPL-3.0-only**; es wird nie unter eine nicht freie oder nur quellverfügbare Lizenz gestellt. Ein Rug-Pull per BSL/SSPL/FSL würde das Vertrauen zerstören und zum Förderausschluss führen.

Beiträge werden **inbound = outbound** unter AGPL-3.0-only angenommen, per Sign-off nach dem **Developer Certificate of Origin** (`git commit -s`). Es gibt **weder CLA noch FLA**; daher kann keine Partei, auch nicht die Maintainer:innen, einen Beitrag jemals aus der AGPL herausrelizenzieren.

Die meisten Module stehen selbst unter AGPL-3.0-only, für sie stellt sich diese Frage nicht. Bei den vier Modulen, die geschlossen bleiben (Finanzen, Inhalte, Tresor, Übergabe), ist der tragende Mechanismus die **Prozessgrenze, nicht ein CLA.** Die FSF behandelt alles, was im selben Prozess mit einem AGPL-Programm gelinkt ist (Plugins *und* in die App einkompilierte UI-Routen), als ein zusammengehöriges Werk, das ebenfalls AGPL sein muss, und § 13 löst die Pflicht zur Offenlegung des Quellcodes aus, sobald das veränderte Programm über ein Netzwerk bereitgestellt wird. Deshalb **kann ein geschlossenes Modul nicht „bloß In-App-Routen“** im Kernel sein; um geschlossen zu bleiben, muss es ein **vollständig eigener Dienst** sein (eigene API *und* eigene Oberfläche), den der Kernel über HTTP zusammensetzt („bloße Aggregation“). Geschlossener Code gelangt konstruktionsbedingt nie in die öffentliche Git-Historie: getrennte Repositories, nie ein gemeinsames Monorepo mit einem `ee/`-Verzeichnis.

Den vollständigen Text und die Begründung enthalten [`../README.de.md`](../README.de.md) und [`../CONTRIBUTING.md`](../CONTRIBUTING.md) (englisch).

## Repository-Topologie / Produktfamilie

Gremion ist der offene Kern einer Produktfamilie. Module und Vertikalen liegen in **getrennten Repositories**.

| Repo | Sichtbarkeit | Rolle |
|------|-----------|------|
| **gremion** (dieses Repo) | öffentlich, AGPL-3.0-only | Der Kernel + Modul-SDK + eine Referenz-Core-Shell. Startet eigenständig. |
| Modul-Repositories | gemischt, siehe unten | Ein Repository pro Modul. |
| Vertikalen und die Hosting-Control-Plane | privat | Deployment-spezifische Konfiguration, Seed-Daten und Theming; Hosting / Provisioning / Abrechnung. |

**Module liegen jeweils in einem eigenen Repository und sind nicht durchgehend geschlossen.** Öffentlich, AGPL-3.0-only: die Module für Wahlen, Newsletter, Kalender, Dateien, Nachrichten, Aufgabenboard und Nutzer:innen. Diese Lizenz gilt nur für den Modulcode; die Upstream-Systeme, die diese Module umhüllen (das Helios-Overlay, Nextcloud, der Matrix-Homeserver, LiveKit), behalten ihre eigenen Lizenzen, die im [Lizenzregister](compliance/licence-register.md) (englisch) festgehalten sind. Geschlossen: Finanzen, Inhalte, Tresor, Übergabe. „Modulschicht“ ist nicht als „proprietäre Schicht“ zu lesen, denn der größte Teil ist AGPL. Die Auslagerung aus dem einen Sammel-Repository ist im Gang; deshalb werden die Module heute in einem privaten Sammel-Repository geführt und über Git bezogen statt als veröffentlichte Pakete. `@gremion/db` und `@gremion/ports` werden ab 0.1.0 auf npm veröffentlicht.

**Historie.** Dieses Repository beginnt mit einem einzigen Root-Commit. Es ist eine **frische Extraktion** nur der beschlossenen Kern-Teilmenge, mit einer Bereinigung dieser Teilmenge von Secrets und personenbezogenen Daten, und keine erneute Veröffentlichung des privaten Produkt-Repositorys, dessen Historie privat bleibt.

## Microservice-Roadmap

Die Architektur ist ein **modularer Monolith mit Extraktion nach Bedarf**, auf Grundlage des bewährten `@gremion/ports` und eines siebenteiligen Playbooks zur Service-Extraktion (Branch by Abstraction → ACL → Outbox → Flag-Flip → Außerbetriebnahme → Dual-Deploy → Rollback). Die Phasen sind nach Schwierigkeit geordnet:

- **Phase 0 (erledigt): Newsletter.** Eigener Container, eigene Datenbank, HTTP-REST-ACL, NATS JetStream. Live umgestellt; der alte Pfad ist außer Betrieb genommen. Die bewährte Vorlage und der erste tragende Gremion-Microservice.
- **Phase 1 (leicht): Dateien, Nachrichten, Abstimmungen.** Bereits lose gekoppelte HTTP-Proxys zu externen Systemen, ohne lokale Datenbank, die zu migrieren wäre; der Aufwand liegt darin, jeden Proxy als Dienst über den Ports-Vertrag zu formalisieren.
- **Phase 2 (mittel): Inhalte, Kalender.** Eigene Daten in der gemeinsamen Datenbank, ohne Fremdschlüssel in die Governance; der Aufwand ist eine Migration von der gemeinsamen zur eigenen Datenbank plus die Anbindung der Outbox. Inhalte brauchen einen Portal-Kernel-Callback, weil `news_posts` der Governance gehört.
- **Phase 3 (schwer): Finanzen.** Das Modul, das man am liebsten privat hielte, ist zugleich das am stärksten mit dem öffentlichen Governance-Kern verflochtene (drei `ON DELETE RESTRICT`-Fremdschlüssel in `public.org_units` plus ein Rück-Import). Der Aufwand ist ein Wechsel des Konsistenzmodells: Guard auf Anwendungsebene plus Abgleich, Umkehrung des Rück-Imports und Aufspaltung des atomaren `createSubOrg` in eine Saga.

**Voraussetzungen für Open Core (das Scharnier, beide umgesetzt):** den Rück-Import `org-units-db → finance/tx` invertieren und die Auto-Discovery des Registers so bauen, dass der Kernel das Manifest eines Moduls nie fest verdrahtet.

**Modulform.** Ein Modul, das geschlossen bleibt, kann nicht „bloß In-App-Routen“ im Kernel sein (siehe [Lizenzierung und Beiträge](#lizenzierung-und-beiträge)); daher sind die vier geschlossenen Module vollständige eigene Dienste mit eigener API *und* eigener Oberfläche, über HTTP zusammengesetzt. Für die AGPL-Module gilt diese Einschränkung nicht.

## Verhältnis zu StuRaOS und Stand

**Gremion ist das Framework; StuRaOS ist sein erstes Referenz-Deployment („Branch“).** In StuRaOS wurde die Governance-Ontologie zuerst umgesetzt; Gremion verallgemeinert sie zu einer domänenneutralen Grundlage. Nach dem Herauslösen bleibt StuRaOS das vollständig integrierte Produkt und die StuRa-Demo, und das deutsche Finanzvokabular (KV/HV, *Finanzordnung*) wird zu einem Plugin der Vertikale herabgestuft und ist nicht Teil des Kerns.

**Laufzeitreife, ehrlich benannt:** Gremion ist entwurfs- und codereif, aber laufzeitunreif: „Die Naht ist auf beiden Seiten präzise gezogen und nie durchtrennt.“ Die Code-Vollständigkeit auf dem Branch liegt bei etwa 70 % bis v1; der Anteil, der in Produktion trägt, liegt nach der Newsletter-Umstellung bei etwa 28–30 %.

**Restposten aus dem Herauslösen** werden einzeln in [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) (englisch) geführt. Es sind Überbleibsel der Extraktion, die dort aufgelistet bleiben, bis sie entfernt oder verallgemeinert sind, statt gegen ein Datum versprochen zu werden.

**Boot-Smoke bestätigt:** Der Kernel startet eigenständig. Die Kette wird sauber gegen ein echtes `postgres:18-alpine` angewendet (bei deaktivierten Seeds eine frühere Zählung der Governance-Migrationen, gemessen vor dem Eintreffen von `0060`, plus 5 Control-Migrationen; `make fresh-init-proof` misst sie neu), die Register-Nähte sind aktiv, es gibt keine Modulfehler; das einzige Nicht-Grüne ist das erwartete 503 „incomplete brand identity“ eines frischen Kernels, das der Setup-Assistent auflöst.

## Was dieses Repository nicht enthält

Klar benannt, weil man sonst das Gegenteil annehmen würde:

- **Nicht das vollständige Schema des Produkts.** Hier werden 34 Data-Plane-Migrationen ausgeliefert: 31 der 58 im Produkt plus die reinen Kernel-Migrationen `0059`, `0060` und `0061`; **27 fehlen** somit. Alle gehören zu Funktionsmodulen, die nicht Teil des Kernels sind und in eigenen Repositories ausgeliefert werden, nämlich Finanzen (`013`–`017`, `019`–`023`, `025`–`032`, `035`, `036`) und Inhalte (`044`–`047`), oder zur Übergabe (`050`–`052`), die in keinem Tree von Release 1 ausgeliefert wird. Keine Migration der Governance-Seite des Produkts fehlt hier mehr: Der Port-back vom 2026-09-15 hat `003`, `034`, `049` und `053`–`058` hereingeholt, die Herkunft steht in [`ops/migration-portback-2026-09-15.md`](./ops/migration-portback-2026-09-15.md) (englisch). Die Lücken in den Dateinamen stammen aus der größeren Kette und sind keine Beschädigung; was hier ist und was nicht, steht in [`../gremion-ui/migrations/README.md`](../gremion-ui/migrations/README.md) (englisch).
- **Nicht der volle Funktionsumfang der Governance.** Das **Schema** für Anfechtbarkeit und Abberufung (Contestability / Recall) ist hier (`055`, `056`); seine Anwendungshälfte (Routen, Services, Oberfläche) und das Second-Locus-Modell sind im Produkt umgesetzt und **nicht** in diesem Kernel, obwohl die Charta oben Rechenschaft und Anfechtbarkeit als Primitiv des Metamodells beschreibt.
- **Der Vertrag des Laufzeit-Registers ist nicht eingefroren.** `lib/server/modules/runtime-registry.ts` und die Form des Manifests sind die Naht des Modul-SDK und können sich weiterhin ohne Auslauffrist ändern. Einen SHA fixieren.
- **`gremion-ui` und `gremion-public` sind eine nicht normative Referenz-Shell.** Sie sind die Shell, mit der der Kernel herausgelöst wurde, kein ratifizierter UI-Vertrag. Ein Deployment darf sie frei ersetzen; nichts in den Garantien des Kernels hängt von ihrem Markup ab.
