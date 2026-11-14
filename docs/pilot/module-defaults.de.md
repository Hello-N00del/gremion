<!-- i18n-sync: source=module-defaults.md sha256=df1352825e06500008e2334dfeda5618a142f5be9d9e855541a6e01aa5ea7cbb -->
[English](./module-defaults.md) | **Deutsch**

# Modul-Standards im Pilot: was das Repository festhält, was gemessen ist, was übergeben wird

> **Status: Produktdokumentation für den Pilot (TASK-058, Teil A).** Sie legt fest, mit
> welchem Modulsatz ein Pilotkunde angelegt wird und welche Teile dieser Festlegung im
> Repository geprüft werden. Sie sagt **nicht**, was ein laufendes System ausliefert: Das
> misst Teil B, der auf TASK-044-b wartet (Abschnitt 3).

## 1. Der vorgesehene Pilotsatz

Ein Pilotkunde wird mit **votes, calendar, content, publishing, files, messaging und board**
angelegt. Die Anlageanfrage nennt jedes Modul ausdrücklich; wer kein Modul nennt, aktiviert
keines (`packages/provisioning/test/code-default-off.test.ts`).

| Modul | Anlageanfrage im Pilot | Grund |
|---|---|---|
| votes | aktiviert | Die zwei offenen Umfrageformen des Pilots ([poll-usage](./poll-usage/README.md)) |
| calendar | aktiviert | Kalender des Gremiums |
| content | aktiviert | Beiträge und Redaktion; seit 2026-11-09 im Standard-Build (`modules/disabled.json` führt nur noch finance und vault) |
| publishing | aktiviert | Newsletter |
| files | aktiviert | Dokumente über Nextcloud, Bearbeitung in Collabora |
| messaging | aktiviert | Chat und Video |
| board | aktiviert | Aufgabenboard je Organisationseinheit; wird im Prozess aus der eigenen Datenbank des Kunden ausgeliefert, die Aktivierung öffnet also keine Moduldatenbank und startet kein Compose-Profil. Es wird bei der Anlage über dasselbe Isolations-Gate gewählt wie die anderen Module (der Board-Isolationsfall, `scripts/verify/suites/isolation-tenant.mjs`) |
| elections | nicht genannt | Optional, keine satzungsgemäße Wahl ([elections-scope](../compliance/elections-scope.de.md)); startet aus und wird in der App-Konfiguration ausgeschaltet gehalten (`defaultEnabled: false` im Manifest und eine Festschreibung beim Lesen und Schreiben von `config.modules`), sodass weder die Navigation noch `/votes` Wahl-Wortlaut tragen; auf jeder Seite unter `/elections` ist ein dauerhafter Hinweis eingebunden |
| finance, vault | nicht genannt | Vom Standard-Build ausgeschlossen (`modules/disabled.json`) |
| handover | nicht genannt | Nicht Teil des Pilotsatzes |

Alle sieben Pilotmodule sind abwählbar; sie werden je Kunde bei der Anlage gewählt, und ein
ausgeschaltetes Modul muss den Kernel funktionsfähig lassen, ohne hängenden Verweis darauf (die
Navigationseinträge von calendar, files, messaging und content tragen ihre Modul-ID und
entfallen).

## 2. Was das Repository prüft (Teil A)

`node scripts/check-pilot-module-defaults.mjs`, mit den Tests in
`scripts/check-pilot-module-defaults.test.mjs`:

- (a) `test/host/fixtures/module-defaults/pilot-request.json` aktiviert votes, calendar,
  content, publishing, files, messaging und board und keines von elections, finance, vault,
  handover; jede genannte ID hat eine `module.json`.
- (b) keine `COMPOSE_PROFILES`-Zeile in `infra/host/templates/env/*.env.tmpl` nennt finance,
  board, vault oder vaultwarden (board braucht keines: es läuft im Prozess). Die Profile der Pilotmodule werden aus
  `infra/host/module-profiles.json` gerendert, nicht in eine Vorlage geschrieben.
- (c) keine `modules/*/module.json` enthält eine Deklaration zur Standardaktivierung.
- (d) das Create-Formular des Panels wählt kein Modul-Kontrollkästchen vor.

Ebenfalls vorhanden: der Elections-Hinweis (`ElectionsNotice.svelte`, eingebunden durch
`modules/elections/app/routes/elections/+layout.svelte`, Text festgelegt in
`modules/elections/src/notice/notice.ts`) und das Schema des Nutzungsnachweises
(`poll-usage/record.schema.json`, gelintet gegen DB-MSG-POLL-USAGE).

Das sind Prüfungen am Repository. Sie zeigen, was deklariert ist, nicht, was der laufende
Stack eines Kunden ausliefert.

## 3. Was nicht behauptet wird

**Elections werden in der App-Konfiguration ausgeschaltet gehalten, auf dem laufenden System ist
das nicht gezeigt.** Das Modul-Gate (`gremion-ui/src/lib/server/module-gate.ts`) liest nur die
Einstellung je Instanz; die Aktivierungsstufe je Kunde (`plt.module_enablement`) wird noch nicht
je Anfrage ausgewertet. Das ist TASK-044-b, zu dem es weder ein Briefing noch einen Commit gibt.
Was das Repository festhält: `config.modules` eines frischen Mandanten liest `elections: false`
(Manifest-Standard plus eine Festschreibung, die weder ein gespeicherter Wert noch ein Schreibzugriff
der Einstellungen aufweichen kann), und `/elections`, `/api/elections`, die Navigation und der
Seitenkopf von `/votes` folgen dem. Bis der benannte Ende-zu-Ende-Nachweis (Teil B, TASK-058-B)
auf einem laufenden Stack besteht, darf kein Dokument, kein Angebot und keine Demo sagen, das
laufende System liefere keine Wahlseite aus. Die übrigen Module des Pilotsatzes (calendar,
content, publishing, files, messaging) sind bei der Anlage an und werden je Anfrage nur über
dieselbe Konfiguration gesperrt; Stufe 1 je Anfrage ist weiterhin TASK-044-b.

**Board ist bei der Anlage wählbar.** Das Aktivierungs-Gate lehnt es nicht mehr namentlich ab
(nur vault bleibt abgelehnt); es durchläuft das Gate wie jedes andere Modul, auf ein bestandenes
kundenübergreifendes Isolationsergebnis für den eingesetzten Release. Es wird im Prozess auf
Kernel-Tabellen der eigenen Datenbank des Kunden ausgeliefert und hat daher keine eigene
Moduldatenbank. Ein Gremium kann board in den eigenen Einstellungen weiterhin nicht schalten: Dort
bleibt es zurückgehalten. Der Isolationsnachweis für board auf einem laufenden Host wird nach dem
Einsatz erfasst; solange ein Host ihn für den eingesetzten Release nicht erfasst hat, lehnt das Gate
board ab wie jedes Modul ohne Nachweis.

Ein Kunde, der ohne angekreuztes board angelegt wird, hat dafür keine Plattformzeile; das board ist
für ihn also trotzdem eingeschaltet. Um es später auszublenden, auf der Kundenseite zuerst „Modul
aktivieren“ und dann „Modul deaktivieren“ verwenden.

## 4. Übergaben

| An | Was |
|---|---|
| TASK-043d (Create-Formular des Panels) | Das Formular listet die abschaltbaren `plt.module`-Zeilen (`apps/control-panel/src/lib/server/modules.ts`), content und publishing erscheinen also mit dem Katalog; votes, calendar, content, publishing, files, messaging und board ankreuzen, je mit einem DPIA-Verweis. 058 ändert `apps/control-panel` nicht. |
| TASK-044-b | Stufe 1 einmal je Anfrage auflösen, fail-closed; PATCH auf true ohne Stufe 1 antwortet mit 409. Voraussetzung für jede „aus“-Zeile von Teil B. |
| TASK-129 | Ein Feld `ackNotice` im Aktivierungsschritt, damit der Elections-Hinweis dort bestätigt wird, wo das Modul aktiviert wird; die Einbindung in der App ist bereits dauerhaft. |
| TASK-038 (Runbook) | Eine Zeile: votes plus Messaging plus das Compose-Profil für Messaging, denn die Chat-Umfrage (Matrix MSC3381) braucht das Messaging-Profil. |
| Neue Einheit (Vendor-/Automatisierungsschalter) | Jede Automatisierung von Nextcloud-Umfragen zur Abstimmung hinter einen Files-Schalter legen. Nach der Entscheidung vom 2026-10-21 gibt es **kein** Nextcloud-Umfrage-Gate für die Veröffentlichung von Protokollen; dieser Schalter betrifft nur die votes-Umfrage. Hier nicht gebaut. |
| Teil B (TASK-058-B) | Matrix der ausgeschalteten Module auf einem Scratch-Stack, sobald 044-b umgesetzt ist; die Zeilen für finance und vault lassen sich früher nachweisen (sie liefern bereits 404). |
