<!-- i18n-sync: source=README.md sha256=375e7340e76b29f279ef1cc2721ba456c159f4d65d001f290963b1d089a7a92a -->
[English](./README.md) | **Deutsch**

# handover

Platzhalter für das Modul Übergabe (Übergabe der Unterlagen einer Organisation an ihre
Nachfolger:innen). Status: **nur Manifest** ([docs/modules.de.md](../../docs/modules.de.md)).
Das Verzeichnis enthält `module.json` und `package.json` und sonst nichts: keine Routen,
keine Migrationen, keinen Dienst, keine Tests.

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `handover` |
| Manifest-ID (Schlüssel in `config.modules`) | keine in diesem Baum |
| Paket | `handover-module` (keine Skripte, keine Abhängigkeiten) |
| Leaf-Service | keiner |

## Was `module.json` deklariert

Schema-Version 1, Runtime-Version `0.1.0`, keine Datenbank, kein Export, keine zeitgesteuerten
Jobs und kein Plattform-Server (`database`, `export` und `platformServer` sind `null`). Die
Beschreibung in `package.json` besagt, dass das Verzeichnis ein Platzhalter ist, bis eine
`app/`-Hälfte hinzukommt.

## Routen, Migrationen, Konfiguration, externe Dienste

Keine. Jede Aussage über die beiden Dateien hinaus wäre nicht aus Code abgeleitet.

## Aktivieren und Deaktivieren

- Build: nicht in `modules/disabled.json`, und es gibt keine `app/`-Hälfte, die darübergelegt
  werden könnte; das Modul trägt daher nichts zu einem Build bei.
- Pro Kunde: Die Pilot-Anlageanfrage nennt es nicht
  ([pilot/module-defaults.de.md](../../docs/pilot/module-defaults.de.md)). Was ein Aktivieren
  bewirken würde, ist durch nichts in diesem Verzeichnis definiert.

## Tests

Keine. Die repositoryweiten Modulprüfungen (`scripts/check-module-source-scan.mjs`,
`scripts/check-pilot-module-defaults.mjs`, `scripts/check-module-docs.mjs`) lesen die Dateien
dieses Verzeichnisses.

## Nicht aus dem Code belegt

- Der geplante Umfang des Moduls. Andere Dokumente im Repository erwähnen die Übergabe in
  einer Liste von Modulen; keines davon ist eine Spezifikation, und diese Beschreibung stützt sich
  auf keines davon.
