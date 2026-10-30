<!-- i18n-sync: source=module-defaults.md sha256=c50942e32e6c998e084f34d2001ae7484a56312e7a4093eacdb762ddf315a0f8 -->
[English](./module-defaults.md) | **Deutsch**

# Modul-Standards im Pilot: was das Repository festhält, was gemessen ist, was übergeben wird

> **Status: Produktdokumentation für den Pilot (TASK-058, Teil A).** Sie legt fest, mit
> welchem Modulsatz ein Pilotkunde angelegt wird und welche Teile dieser Festlegung im
> Repository geprüft werden. Sie sagt **nicht**, was ein laufendes System ausliefert: Das
> misst Teil B, der auf TASK-044-b wartet (Abschnitt 3).

## 1. Der vorgesehene Pilotsatz

Ein Pilotkunde wird mit **votes** angelegt, und standardmäßig ist nichts anderes aktiviert. Die
Anlageanfrage nennt jedes Modul ausdrücklich; wer kein Modul nennt, aktiviert keines
(`packages/provisioning/test/code-default-off.test.ts`).

| Modul | Anlageanfrage im Pilot | Grund |
|---|---|---|
| votes | aktiviert | Die zwei offenen Umfrageformen des Pilots ([poll-usage](./poll-usage/README.md)) |
| elections | nicht genannt | Optional, keine satzungsgemäße Wahl ([elections-scope](../compliance/elections-scope.de.md)); auf jeder Seite unter `/elections` ist ein dauerhafter Hinweis eingebunden |
| finance, vault, content | nicht genannt | Vom Standard-Build ausgeschlossen (`modules/disabled.json`) |
| board | nicht genannt | Noch nicht mandantengetrennt; vom echten Bereitstellungs-Gate abgelehnt |
| handover | nicht genannt | Nicht Teil des Pilotsatzes |

Calendar, Publishing (newsletter), Messaging und Files sind ebenfalls abwählbar; sie werden je
Kunde bei der Anlage gewählt, und ein ausgeschaltetes Modul muss den Kernel funktionsfähig
lassen, ohne hängenden Verweis darauf.

## 2. Was das Repository prüft (Teil A)

`node scripts/check-pilot-module-defaults.mjs`, mit den Tests in
`scripts/check-pilot-module-defaults.test.mjs`:

- (a) `test/host/fixtures/module-defaults/pilot-request.json` aktiviert votes und keines von
  elections, finance, board, vault, content, handover; jede genannte ID hat eine `module.json`.
- (b) keine `COMPOSE_PROFILES`-Zeile in `infra/host/templates/env/*.env.tmpl` nennt finance,
  board, vault, content oder vaultwarden.
- (c) keine `modules/*/module.json` enthält eine Deklaration zur Standardaktivierung.
- (d) das Create-Formular des Panels wählt kein Modul-Kontrollkästchen vor.

Ebenfalls vorhanden: der Elections-Hinweis (`ElectionsNotice.svelte`, eingebunden durch
`modules/elections/app/routes/elections/+layout.svelte`, Text festgelegt in
`modules/elections/src/notice/notice.ts`) und das Schema des Nutzungsnachweises
(`poll-usage/record.schema.json`, gelintet gegen DB-MSG-POLL-USAGE).

Das sind Prüfungen am Repository. Sie zeigen, was deklariert ist, nicht, was der laufende
Stack eines Kunden ausliefert.

## 3. Was nicht behauptet wird

**Dass elections und board auf dem laufenden System ausgeschaltet sind, ist nicht gezeigt.** Das
Modul-Gate (`gremion-ui/src/lib/server/module-gate.ts`) liest nur die Einstellung je Instanz,
und die Standardeinstellungen belegen jedes abschaltbare Modul mit „an“; die Aktivierungsstufe
je Kunde (`plt.module_enablement`) wird noch nicht je Anfrage ausgewertet. Das ist
TASK-044-b, zu dem es weder ein Briefing noch einen Commit gibt. Bis es umgesetzt ist und der
benannte Ende-zu-Ende-Nachweis (Teil B, TASK-058-B) auf einem Scratch-Stack besteht, kann ein
frischer Kunde weiterhin `/elections` und `/tasks` ausliefern, und kein Dokument, kein Angebot und
keine Demo darf sagen, dass elections oder board auf einem laufenden System standardmäßig aus
sind. Die Aussage „standardmäßig aus“ gilt für die Anlageanfrage und den Build, noch nicht
für die ausgelieferten Routen.

## 4. Übergaben

| An | Was |
|---|---|
| TASK-043d (Create-Formular des Panels) | **votes** in der Modulliste anbieten (heute: calendar, content, publishing, finance) und die IDs gegen den Modulkatalog validieren. 058 ändert `apps/control-panel` nicht. |
| TASK-044-b | Stufe 1 einmal je Anfrage auflösen, fail-closed; PATCH auf true ohne Stufe 1 antwortet mit 409. Voraussetzung für jede „aus“-Zeile von Teil B. |
| TASK-129 | Ein Feld `ackNotice` im Aktivierungsschritt, damit der Elections-Hinweis dort bestätigt wird, wo das Modul aktiviert wird; die Einbindung in der App ist bereits dauerhaft. |
| TASK-038 (Runbook) | Eine Zeile: votes plus Messaging plus das Compose-Profil für Messaging, denn die Chat-Umfrage (Matrix MSC3381) braucht das Messaging-Profil. |
| Neue Einheit (Vendor-/Automatisierungsschalter) | Jede Automatisierung von Nextcloud-Umfragen zur Abstimmung hinter einen Files-Schalter legen. Nach der Entscheidung vom 2026-10-21 gibt es **kein** Nextcloud-Umfrage-Gate für die Veröffentlichung von Protokollen; dieser Schalter betrifft nur die votes-Umfrage. Hier nicht gebaut. |
| Teil B (TASK-058-B) | Matrix der ausgeschalteten Module auf einem Scratch-Stack, sobald 044-b umgesetzt ist; die Zeilen für finance, vault und content lassen sich früher nachweisen (sie liefern bereits 404). |
