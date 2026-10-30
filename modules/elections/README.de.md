<!-- i18n-sync: source=README.md sha256=a08e03a7afffe44cfccbccb8fe3be8bd30cfa8b9da7c65e7c9b34d3ea87f2d3c -->
[English](./README.md) | **Deutsch**

# elections

Optionale Gremienwahlen auf einem Helios-Abstimmungsserver: Wahl für ein Gremium anlegen,
ihren Zustand verfolgen (Entwurf, offen, geschlossen) und die Abstimmung öffnen. Das Modul
führt keine satzungsgemäße Wahl durch; darauf weist ein dauerhafter Hinweis auf jeder
`/elections`-Seite hin. Status: **unterstützt** ([docs/modules.de.md](../../docs/modules.de.md)).
Es besteht aus einer App-Hälfte und einer kleinen Bibliothek; es gibt keinen Leaf-Service und
kein Dockerfile.

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `elections` |
| Manifest-ID (Schlüssel in `config.modules`) | `elections` |
| Paket | `elections-module` |
| Navigationssegment | `/elections` (Mindestrolle: Mitglied) |
| Leaf-Service | keiner (der Votes-Leaf, [modules/votes](../votes/README.de.md), liefert die kombinierte Liste) |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die prozessinterne Hälfte, über `gremion-ui/src/` gelegt: Seiten, `/api/elections`, der Helios-Client und der Wahlspeicher (`app/lib/server/elections/`), der Backend-Port, die Hinweiskomponente, die Typen des Abstimmungsaggregators, das Manifest, der Seeder. |
| `src/notice/` | Der Hinweistext bei der Aktivierung (`notice.ts`), als deutsche Prosa in einer Du- und einer Sie-Form, mit seinen Fakten (`optional`, nicht standardmäßig aktiviert, führt keine satzungsgemäße Wahl durch). Von `src/index.ts` exportiert. |
| `test/` | `notice.test.ts` sichert den Wortlaut gegen die Formulierungen ab, die das Dokument zum Geltungsbereich der Wahlen verbietet; `notice-keys.test.ts` bindet ihn an den i18n-Katalog der Host-App. |

## Routen und API-Oberfläche

| Route | Methoden |
|---|---|
| `/elections`, `/elections/new`, `/elections/manage`, `/elections/[id]`, `/elections/[id]/manage`, `/elections/[id]/helios-cb` | Seiten |
| `/api/elections` | GET, POST |

Die Hinweiskomponente wird von `app/routes/elections/+layout.svelte` eingebunden.

## Migrationen

Keine in diesem Verzeichnis (`module.json` deklariert `database: null`). Die Tabelle, die das
Modul nutzt, `committee_elections`, gehört zum Kernel-Schema und wird von den
Kernel-Migrationen angewendet, unabhängig davon, ob das Modul aktiviert ist; das Manifest deklariert
bewusst keine `migrations`, weil eine spätere Kernel-Migration diese Tabelle in jedem Fall
ändert.

## Konfiguration

| Variable | Verwendet von | Bedeutung |
|---|---|---|
| `HELIOS_URL`, `PUBLIC_HELIOS_URL` | Kernel-App | Interne und browserseitige URL des Helios-Servers. |
| `HELIOS_SERVICE_EMAIL`, `HELIOS_SERVICE_PASSWORD` | Kernel-App | Dienstkonto, mit dem sich der Helios-Client anmeldet (benannt in `helios-client.ts`; der Umgang mit dem Geheimnis wurde nicht nachverfolgt). |
| `VOTES_BACKEND` | Kernel-App | `inprocess` (Standard) oder `service`; jeder andere Wert wird abgelehnt. |
| `VOTES_SERVICE_URL`, `INTERNAL_VOTES_SECRET` | Kernel-App | Basis-URL und gemeinsames Geheimnis des Votes-Leafs, wenn das Backend `service` ist. |
| `PUBLIC_BASE_URL` | Kernel-App | Öffentliche Basis-URL der Instanz. |
| `TRACE_EXPORTER` | Kernel-App | Auswahl des Tracing-Exporters. |

## Externe Dienste

- Helios, der Wahlserver. Seine Administration bleibt bewusst in der Kernel-App.

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Pro Kunde: nicht aktiviert, solange es nicht genannt wird. Die Pilot-Anlageanfrage nennt es
  nicht ([pilot/module-defaults.de.md](../../docs/pilot/module-defaults.de.md)); `--enable elections`
  bei der Anlage oder die Anfrage `enable_module` des Panels schaltet es ein.
- Instanzeinstellung: `config.modules.elections = false` beantwortet `/elections` und
  `/api/elections` mit der Oberfläche für deaktivierte Module. Die Seite `/votes` blendet dann
  jeden Helios-Eintrag aus.
- Der Wortlaut des Hinweises und was er behaupten darf und was nicht, ist in
  [compliance/elections-scope.de.md](../../docs/compliance/elections-scope.de.md) festgelegt.

## Tests

- `pnpm --filter elections-module test` und `typecheck`.
- `test/notice-keys.test.ts` liest `gremion-ui/src/lib/i18n/messages/{de,en}.json`; es ist
  der einzige gekoppelte Test, den `modules/COUPLED-TESTS.json` aufführt, sodass ein eigenständiger Checkout
  des Moduls diesen Katalog bereitstellen oder den Test ausnehmen muss.
- Tests unter `app/` (Client, Aggregator, API-Routen, Löschung) liegen neben dem Code und
  werden vom Skript `test` des Pakets nicht erfasst.

## Nicht aus dem Code belegt

- `docs/pilot/module-defaults.md` sagt, dass auf einem laufenden System nicht gezeigt ist,
  dass das Modul standardmäßig aus ist; dieses README trifft dazu keine Aussage.
