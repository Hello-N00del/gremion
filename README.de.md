<!-- i18n-sync: source=README.md sha256=60621121e829556dfb480eefa5c928e298ad7b546628f86b023a09f511c82dc9 -->
[English](./README.md) | **Deutsch**

# Gremion

**Gremion** ist ein offener, selbst betreibbarer **Kernel für digitale Governance** für Räte, Studierendenparlamente (*Studierendenräte*), Vereine und ähnliche beratende Gremien. Er liefert die Grundlage, die jedes solche Gremium braucht: Identität, Mandantenfähigkeit, ein Organisations- und Gremienmodell, Protokolle und Beschlüsse mit hash-verkettetem Audit-Trail sowie eine Entscheidungs-Engine, die das Quorum berücksichtigt. Darauf setzt ein **Modul-SDK** auf, in das sich optionale Funktionen einklinken, ohne dass der Kernel jemals von ihnen abhängt.

> Gremion ist der offene Kern einer größeren Produktfamilie. Funktionsmodule (Aufgabenboard, Kalender, Inhalte, Wahlen, Dateien, Finanzen, Übergabe, Nachrichten, Veröffentlichung (der Newsletter), Tresor, Abstimmungen) liegen unter [`modules/`](./modules), ein Verzeichnis pro Modul, und docken über das Modul-SDK an; [docs/modules.de.md](./docs/modules.de.md) nennt, welche unterstützt werden und welche standardmäßig deaktiviert sind. Der Kernel **baut und startet eigenständig, ohne dass ein Modul vorhanden ist**.

## Lizenz

Gremion steht unter der **GNU Affero General Public License v3.0 only** (AGPL-3.0-only), siehe [`LICENSE`](./LICENSE). Diese Lizenz ist **dauerhaft**: Das Projekt wird nie unter eine nicht freie oder nur quellverfügbare Lizenz gestellt. Beiträge werden **inbound = outbound** unter AGPL-3.0-only angenommen, per Sign-off nach dem Developer Certificate of Origin, ohne CLA. Siehe [`CONTRIBUTING.md`](./CONTRIBUTING.md) (englisch).

## Was der Kernel enthält

- **Identität und Authentifizierung**: Keycloak OIDC, Rollen- und Capability-Modell, Step-up-Anbindung (LoA/ACR).
- **Mandantenfähigkeit**: Datenisolation pro Mandant, das Control-Plane-Register, Fleet-Migrationen.
- **Governance-Domäne**: Gremien, Mitglieder, der Baum der Organisationseinheiten, Protokolle, *Beschlüsse*, das öffentliche Portal.
- **Governance-Invarianten**: hash-verkettetes Audit-Log (INV-1) und die Engine für Quorum und Entscheidungsregeln (INV-5).
- **Modul-SDK**: manifestgesteuerte Registrierung (Navigation, Seiten, Capabilities, Migrationen, Realm-Fragmente), Laufzeit-Register (Boot-Hooks, Tenant-Evict-Hooks, Provisioning-Adapter, Datenanbieter) und der Boundary Enforcer, der den Kernel frei von Abhängigkeiten von Funktionsmodulen hält.
- **Dienste und Betriebswerkzeuge**: das Control Panel (`apps/control-panel`, die Betreiberoberfläche, die Kundenanfragen einreiht und die Kennzahlen des Hosts sowie eine Code-Karte zeigt), die Kernel-API (`services/kernel-api`: Mandantenauflösung, Modulregister, Identitätsdomäne, Autorisierungsentscheidungen), der Governance-Dienst (`services/governance`, bisher sein Schema) und die hostseitigen Werkzeuge in `infra/host`.
- **Gemeinsame Pakete**: die `@gremion/*`-Workspaces unter `packages/` (zum Beispiel `@gremion/db`, `@gremion/ports` für Broker und Tracer, `@gremion/events`, `@gremion/tenancy-core`, `@gremion/tenant-store`, `@gremion/nats-auth`, `@gremion/provisioning`, `@gremion/retention`).

Ein Funktionsmodul ist alles, was der Kernel über dieses SDK entdeckt; der Kernel importiert keines davon namentlich. Die Abhängigkeitsrichtung (Kernel → nie ein Modul) wird im Code durch `gremion-ui/src/lib/server/boundary/` durchgesetzt.

## Was der Kernel noch *nicht* enthält

Das sollte man wissen, bevor man Planungen auf dieses Repository stützt, nicht erst danach:

- **Nicht das vollständige Schema des Produkts.** Hier werden 38 Data-Plane-Migrationen ausgeliefert: 31 der 58 im Referenzprodukt sowie die reinen Kernel-Migrationen `0059`, `0060`, `0061`, `0062`, `0063`, `0064` und `0065`; **27 fehlen** somit. Jede davon gehört einem Modul (Finanzen, Inhalte) oder wird nicht ausgeliefert (Übergabe). Die Lücken in den Dateinamen stammen aus dieser größeren Kette und sind keine Beschädigung; siehe [`gremion-ui/migrations/README.md`](./gremion-ui/migrations/README.md) (englisch), das auflistet, was hier vorhanden ist, und benennt, was nicht.
- **Nicht der volle Funktionsumfang der Governance.** Das **Schema** für Anfechtbarkeit und Abberufung (Contestability / Recall) wird hier ausgeliefert (`055`, `056`); seine Anwendungshälfte (Routen, Services, Oberfläche) und das Second-Locus-Modell sind im Produkt umgesetzt und **fehlen hier**, obwohl die Charta Rechenschaft und Anfechtbarkeit als gleichrangige Grundbestandteile behandelt.
- **Der Vertrag des Laufzeit-Registers im Modul-SDK ist nicht eingefroren.** Die Form des Manifests und `runtime-registry.ts` können sich weiterhin ohne Auslauffrist ändern. Statt `main` zu verfolgen, sollte ein SHA fixiert werden.
- **`gremion-ui` und `gremion-public` sind eine nicht normative Referenz-Shell.** Sie sind die Shell, mit der der Kernel herausgelöst wurde, kein ratifizierter UI-Vertrag. Wer sie ersetzt, verletzt keine Garantie des Kernels.
- **Keine stabile Release-Linie.** Dies ist 0.1.0. Korrekturen landen auf `main`; für ältere SHAs gibt es keinen Backport-Kanal.

## Schnellstart (lokal, Docker Compose)

```bash
./scripts/setup.sh        # creates .env and legal/legal.env, generates the secrets and the internal TLS certificates; on a fresh clone it then stops at the image build
echo "TENANT_PROXY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env
./scripts/setup.sh        # keeps the .env, builds and starts the stack
make logs
```

`setup.sh` schreibt `.env` selbst (aus `.env.example`, danach `chmod 600`) und erzeugt jedes darin enthaltene Secret, einschließlich des vorbelegten Fixture-Passworts. Die `.env` **nicht** vorher von Hand anlegen: Das Skript überspringt die Erzeugung, wenn die Datei bereits existiert, und es blieben die `CHANGE_ME_*`-Platzhalter stehen.

Der erste Lauf bricht ab, weil `docker-compose.app.yml` `TENANT_PROXY_SHARED_SECRET` verlangt und `setup.sh` den Wert nicht erzeugt; der zweite Lauf behält die `.env` und läuft weiter. Ist der Wert gesetzt, beantwortet die App auf Port 3001 nur Anfragen, die die Header des Mandanten-Resolvers tragen (ausgenommen `/healthz`); im lokalen Stack ist sie daher mit `curl` erreichbar, nicht aus einem Browser: siehe [`docs/LOCAL_TESTING.md`](./docs/LOCAL_TESTING.md#quick-start) (englisch).

`setup.sh` lässt in `legal/legal.env` Platzhalter für das Impressum stehen; sie sind vor dem Livegang auszufüllen. Ein Keycloak-Realm entsteht erst beim Anlegen eines Mandanten, nicht beim Start.

Der lokale Stack besteht aus zwei Compose-Projekten, die `make up` startet. Das State-Projekt (`docker-compose.yml` plus die automatisch geladene `docker-compose.override.yml`) betreibt **postgres, governance-postgres, nats, keycloak, legal, vector** und unter dem Profil `dev` **mailpit**. Die App-Farbe (`docker-compose.app.yml` plus `docker-compose.app.dev.yml`) betreibt **gremion-ui, gremion-public, control-panel, kernel-api**. Modul-Dienste und ihre Datenbanken liegen hinter Compose-Profilen (board, calendar, content, finance, newsletter, vault, messaging, nextcloud, collabora, video). `traefik` und `docker-socket-proxy` kommen unter dem Profil `production` hinzu, `pgbouncer` und `fallback` aus `docker-compose.prod.yml`.

## Entwicklung

```bash
pnpm install                 # Node 26, pnpm 10
pnpm -C gremion-ui check     # i18n compile, tenancy/port/secrets-dir guards, then svelte-check
pnpm -C gremion-public check # i18n compile, then svelte-check
pnpm -C gremion-ui test:unit
pnpm -C gremion-ui build     # adapter-node production build
make lint                    # the static guards (compose, shell, hygiene, migration register, ...)
make verify                  # the local gate: typecheck, unit, integration and the other required suites
```

## Dokumentation

- **[docs/about-gremion.de.md](./docs/about-gremion.de.md)**: die vollständige Übersicht. Was Gremion leistet, für wen es gedacht ist, die Open-Core-Architektur mit drei Schichten, die Governance-Charta und ihre Invarianten, das Modul-SDK, Lizenzierung und Beiträge, die Repository- und Produktfamilie sowie die Microservice-Roadmap.
- **[docs/INDEX.md](./docs/INDEX.md)** (englisch): das Dokumentationsverzeichnis mit Architektur und Sicherheit, Entwicklung, Betrieb und Deployment, den Playbooks zum Modul-SDK und den Decision Records. Diese Dokumente wurden auf den Governance-Kernel umgeschrieben, als er aus dem größeren Produkt-Tree herausgelöst wurde; verbleibende Restposten aus dem Herauslösen werden in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) geführt.
- **[docs/modules.de.md](./docs/modules.de.md)**: die Module unter `modules/` mit Zweck, Unterstützungsstatus (unterstützt, standardmäßig deaktiviert, nur Manifest), den jeweils benötigten externen Diensten und einem Link auf das README des jeweiligen Moduls.
- **[KNOWN_ISSUES.md](./KNOWN_ISSUES.md)** (englisch): die ehrliche Restpostenliste mit Überbleibseln aus dem Herauslösen, Abweichungen vom Entwurf, nach 0.1.0 mitgeschleppten Namensschulden und der offenen Einschränkung bei den Governance-Invarianten (Abschneiden am Ende der Audit-Kette).
- **[SECURITY.md](./SECURITY.md)** (englisch): unterstützte Versionen und wie man eine Schwachstelle vertraulich meldet.
- **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** (englisch): Contributor Covenant 2.1 und die Kontaktstelle für die Durchsetzung.
- **[docs/TRADEMARK.md](./docs/TRADEMARK.md)** (englisch): der Projektname und sein Status.

## Status

Öffentlich, AGPL-3.0-only, Version 0.1.0. Der Kernel baut und startet eigenständig; der Vertrag des Modul-SDK ist noch nicht eingefroren. Korrekturen landen auf `main`, und Konsument:innen fixieren einen SHA, siehe [`SECURITY.md`](./SECURITY.md). Bekannte Einschränkungen und Restposten stehen in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md).
