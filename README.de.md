<!-- i18n-sync: source=README.md sha256=d1e4f1477a3cf02049130635e7b2e248b688cc00b6b608eb69918ec680876fd8 -->
[English](./README.md) | **Deutsch**

# Gremion

**Gremion** ist ein offener, selbst betreibbarer **Kernel für digitale Governance** für Räte, Studierendenparlamente (*Studierendenräte*), Vereine und ähnliche beratende Gremien. Er liefert die Grundlage, die jedes solche Gremium braucht: Identität, Mandantenfähigkeit, ein Organisations- und Gremienmodell, Protokolle und Beschlüsse mit hash-verkettetem Audit-Trail sowie eine Entscheidungs-Engine, die das Quorum berücksichtigt. Darauf setzt ein **Modul-SDK** auf, in das sich optionale Funktionen einklinken, ohne dass der Kernel jemals von ihnen abhängt.

> Gremion ist der offene Kern einer größeren Produktfamilie. Funktionsmodule (Wahlen, Newsletter, Kalender, Dateien, Nachrichten, Aufgabenboard, Nutzer:innen, Finanzen, Inhalte, Tresor, Übergabe) liegen in **eigenen Repositories**, eines pro Modul, und docken über das Modul-SDK an. Der Kernel **baut und startet eigenständig, ohne dass ein Modul vorhanden ist**.

## Lizenz

Gremion steht unter der **GNU Affero General Public License v3.0 only** (AGPL-3.0-only), siehe [`LICENSE`](./LICENSE). Diese Lizenz ist **dauerhaft**: Das Projekt wird nie unter eine nicht freie oder nur quellverfügbare Lizenz gestellt. Beiträge werden **inbound = outbound** unter AGPL-3.0-only angenommen, per Sign-off nach dem Developer Certificate of Origin, ohne CLA. Siehe [`CONTRIBUTING.md`](./CONTRIBUTING.md) (englisch).

## Was der Kernel enthält

- **Identität und Authentifizierung**: Keycloak OIDC, Rollen- und Capability-Modell, Step-up-Anbindung (LoA/ACR).
- **Mandantenfähigkeit**: Datenisolation pro Mandant, das Control-Plane-Register, Fleet-Migrationen.
- **Governance-Domäne**: Gremien, Mitglieder, der Baum der Organisationseinheiten, Protokolle, *Beschlüsse*, das öffentliche Portal.
- **Governance-Invarianten**: hash-verkettetes Audit-Log (INV-1) und die Engine für Quorum und Entscheidungsregeln (INV-5).
- **Modul-SDK**: manifestgesteuerte Registrierung (Navigation, Seiten, Capabilities, Migrationen, Realm-Fragmente), Laufzeit-Register (Boot-Hooks, Tenant-Evict-Hooks, Provisioning-Adapter, Datenanbieter) und der Boundary Enforcer, der den Kernel frei von Abhängigkeiten von Funktionsmodulen hält.
- **Gemeinsame Pakete**: `@gremion/db`, `@gremion/ports` (Broker / Tracer).

Ein Funktionsmodul ist alles, was der Kernel über dieses SDK entdeckt; der Kernel importiert keines davon namentlich. Die Abhängigkeitsrichtung (Kernel → nie ein Modul) wird im Code durch `gremion-ui/src/lib/server/boundary/` durchgesetzt.

## Was der Kernel noch *nicht* enthält

Das sollte man wissen, bevor man Planungen auf dieses Repository stützt, nicht erst danach:

- **Nicht das vollständige Schema des Produkts.** Hier werden 34 Data-Plane-Migrationen ausgeliefert: 31 der 58 im Referenzprodukt sowie die reinen Kernel-Migrationen `0059`, `0060` und `0061`; **27 fehlen** somit. Jede davon gehört einem Modul (Finanzen, Inhalte) oder wird nicht ausgeliefert (Übergabe). Die Lücken in den Dateinamen stammen aus dieser größeren Kette und sind keine Beschädigung; siehe [`gremion-ui/migrations/README.md`](./gremion-ui/migrations/README.md) (englisch), das auflistet, was hier vorhanden ist, und benennt, was nicht.
- **Nicht der volle Funktionsumfang der Governance.** Das **Schema** für Anfechtbarkeit und Abberufung (Contestability / Recall) wird hier ausgeliefert (`055`, `056`); seine Anwendungshälfte (Routen, Services, Oberfläche) und das Second-Locus-Modell sind im Produkt umgesetzt und **fehlen hier**, obwohl die Charta Rechenschaft und Anfechtbarkeit als gleichrangige Grundbestandteile behandelt.
- **Der Vertrag des Laufzeit-Registers im Modul-SDK ist nicht eingefroren.** Die Form des Manifests und `runtime-registry.ts` können sich weiterhin ohne Auslauffrist ändern. Statt `main` zu verfolgen, sollte ein SHA fixiert werden.
- **`gremion-ui` und `gremion-public` sind eine nicht normative Referenz-Shell.** Sie sind die Shell, mit der der Kernel herausgelöst wurde, kein ratifizierter UI-Vertrag. Wer sie ersetzt, verletzt keine Garantie des Kernels.
- **Keine stabile Release-Linie.** Dies ist 0.1.0. Korrekturen landen auf `main`; für ältere SHAs gibt es keinen Backport-Kanal.

## Schnellstart (lokal, Docker Compose)

```bash
./scripts/setup.sh        # creates .env, generates secrets + the governance-only Keycloak realm, starts the stack
make logs
```

`setup.sh` schreibt `.env` selbst (aus `.env.example`, danach `chmod 600`) und erzeugt jedes darin enthaltene Secret, einschließlich des vorbelegten Fixture-Passworts. Die `.env` **nicht** vorher von Hand anlegen: Das Skript überspringt die Erzeugung, wenn die Datei bereits existiert, und es blieben die `CHANGE_ME_*`-Platzhalter stehen.

Der reine Governance-Stack = **postgres, keycloak, gremion-ui, gremion-public, legal, vector, mailpit** (+ `traefik` und `docker-socket-proxy` unter dem Profil `production` sowie `pgbouncer` / `cloudflared` / `fallback` aus `docker-compose.prod.yml`).

## Entwicklung

```bash
pnpm install
pnpm -C gremion-ui check     # tenancy/port/domain/secrets guards, then svelte-check
pnpm -C gremion-public check
pnpm -C gremion-ui exec vitest run
pnpm -C gremion-ui build     # adapter-node production build
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
