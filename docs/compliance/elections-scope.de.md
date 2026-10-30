<!-- i18n-sync: source=elections-scope.md sha256=a552c346d1c8441b53eb7306470545092081c49608c530fdeaa0745de1e6e921 -->
[English](./elections-scope.md) | **Deutsch**

# Wahlmodul: zulässiger Einsatzbereich und Formulierungsregeln

> **Status: geltende Regel (TASK-005).** Zuletzt geprüft: **2026-09-25**.
> Diese Seite legt fest, wofür das optionale Wahlmodul (das Helios-Overlay auf dem
> Abstimmungsmodul) gedacht ist, was darüber nie gesagt werden darf und welche Prüfung bei
> jedem Helios-Bump läuft. Sie gilt unabhängig davon, ob das Modul aktiviert ist.

## 1. Zulässiger Einsatzbereich

- **Nur interne, nicht satzungsgemäße Umfragen.** Ein Rat darf das Modul für seine eigenen
  internen Abstimmungen und Umfragen nutzen. Es ist **nicht** für die satzungsgemäße Wahl einer
  Studierendenschaft, eines Rates oder eines anderen gewählten Organs gedacht.
- **Satzungsgemäße Wahlen sind ausdrücklich kein Ziel.** Sie werden von der Hochschule durchgeführt,
  in der Regel über deren eigenen Wahldienst; die Plattform übernimmt sie nicht und tritt
  nicht in Konkurrenz dazu.
- **Im Pilot aus.** Es ist nicht geplant, dass ein Rat eine echte Wahl über Helios abhält; das
  Modul bleibt für den Pilot-Rat ausgeschaltet.
- **Überall sonst standardmäßig aus.** Für jeden neu bereitgestellten Rat ist das Modul
  deaktiviert, bis ein:e Administrator:in es ausdrücklich aktiviert
  (PRD-ELE-001; das Bereitstellungsverhalten und sein Test gehören zu TRD-030, nicht zu dieser
  Seite).
- **Hinweis auf den tatsächlichen Einsatzbereich.** Wo immer das Modul aktiviert ist, soll es einen
  Hinweis anzeigen, dass es nicht die satzungsgemäße Wahl der Hochschule durchführt und dass es
  optional und abschaltbar ist (PRD-ELE-002; keine Aussage über den Standardzustand, bis TASK-044-b
  den Standard umstellt). Vorgeschlagener Wortlaut:
  - DE: „Dieses Modul führt keine satzungsgemäßen Wahlen der Hochschule durch. Es ist
    optional und kann von der Verwaltung des Gremiums ausgeschaltet werden."
  - EN: "This module does not run the university's statutory elections. It is optional
    and can be switched off by the council's administration."
- **Gefordert, noch nicht gebaut.** Die Regel „standardmäßig aus“ und der Hinweis sind
  Anforderungen, keine Beschreibung des heutigen Builds: Das PRD hält fest, dass das Modul
  derzeit standardmäßig aktiviert ist (PRD Abschnitt 15, Block C12), und in der
  Produktoberfläche gibt es noch keinen Hinweistext. Die Änderung an der
  Bereitstellung gehört zu TRD-030, der Hinweis zur Überarbeitung des Wortlauts von
  PRD-ELE-002. Die Formulierungsregeln in Abschnitt 2 gelten unabhängig davon schon heute.

## 2. Was kein Material sagen darf

Gilt für Produkttexte, das öffentliche Portal, Vertriebsmaterial (das Angebot, die Website,
jedes Demo-Skript) und Onboarding-Material, auf Deutsch und Englisch, **unabhängig davon, ob
das Modul aktiviert ist** (TRD-112):

1. **Keine Aussage, dass Online-Wahlen der Studierendenschaft rechtmäßig sind**, weder in
   einem Bundesland noch anderswo. Ihre Rechtmäßigkeit ist nicht festgestellt, und eine
   nicht festgestellte Tatsache wird nicht behauptet, auch nicht als „in den meisten Bundesländern“
   oder „im Allgemeinen“.
2. **Keine Darstellung des Moduls als für den satzungsgemäßen Einsatz geeignet**: weder als
   Ersatz für die Wahl der Hochschule, noch als Erfüllung eines Wahlgesetzes oder der
   Wahlregeln einer Satzung, noch als zertifiziertes oder zugelassenes Wahlsystem.
3. **Keine rechtliche Aussage zu geheimen Umfragen.** Das Produkt darf die
   Geheimhaltungseigenschaften beschreiben, die es nachweislich hat (eine Stimme je
   stimmberechtigtem Mitglied; keine abrufbare Verbindung zwischen einer wählenden Person und
   einer Auswahl; ein Ergebnis, das mit der Zahl der Stimmberechtigten und der Zahl der
   abgegebenen Stimmen festgehalten wird). Es sagt nichts darüber, ob eine solche Umfrage das
   Erfordernis der geheimen Wahl irgendeiner Satzung erfüllt.

**Verbotene Formulierungen** (die Prüfung des Marketingtextes, `make lint-compliance`,
beschrieben in [licence-register.md](licence-register.md) (englisch), Abschnitt 5, liest diese
Tabelle und schlägt bei jeder darin zitierten Formulierung fehl; die Liste ist eine
Untergrenze, keine Positivliste für alles andere):

| Deutsch | Englisch |
|---|---|
| „rechtssichere Wahl", „rechtssichere Online-Wahl" | "legally compliant election", "legally secure election" |
| „rechtsgültige Wahl", „rechtskonforme Wahl" | "legally valid election", "lawful online election" |
| „zulässig nach Landesrecht", „in allen Bundesländern zulässig" | "permitted in every German state", "lawful in [any Land]" |
| „für satzungsgemäße Wahlen geeignet", „ersetzt die Hochschulwahl" | "suitable for statutory elections", "replaces the university election" |
| „amtliche Wahl", „offizielle Gremienwahl" | "official election", "binding student-body election" |
| „zertifiziertes Wahlsystem", „BSI-zertifiziert" (für dieses Modul) | "certified voting system", "government-approved e-voting" |

**Erlaubt** (beschreibend, ohne rechtliche oder satzungsbezogene Aussage): „interne
Abstimmungen und Umfragen des Gremiums", „optionales Modul, standardmäßig aus",
"internal council polls", "optional module, off by default", sowie die
Geheimhaltungseigenschaften aus Punkt 3, dargestellt als Produkteigenschaften.

**Gemessener Stand am 2026-09-25:** Eine Suche in den Produkttexten, dem öffentlichen Portal,
der `README.md` und `docs/about-gremion.md` dieses Repositorys nach Formulierungen zu
Rechtmäßigkeit oder satzungsgemäßer Eignung von Wahlen ergab **keinen Verstoß**. Ein Produkttext
wurde als Grenzfall geprüft und der Überarbeitung des Wortlauts von PRD-ELE-002 überlassen: die
Einstellungsbeschreibung `settings.admin.elections.desc` lautet „Umfragen und geheime Wahlen
konfigurieren". Sie erhebt keinen Anspruch auf Rechtmäßigkeit, aber „Wahlen“ ohne den
Hinweis zum Einsatzbereich lässt sich als satzungsgemäße Wahlen lesen; der Hinweis aus
Abschnitt 1 beseitigt diese Mehrdeutigkeit.

## 3. Vor jedem satzungsgemäßen Einsatz (ruhend)

Sollte das Modul jemals für den satzungsgemäßen Einsatz erwogen werden, was der aktuelle
Einsatzbereich ausschließt, werden zwei zurückgestellte Befunde geringer Schwere in der
Helios-Integration (einer dazu, wie ein Service-Credential gespeichert wird, einer dazu, wie
ein Identitätstoken validiert wird) erneut bewertet und, falls noch offen, behoben, und ein
**datierter Nachweis der erneuten Bewertung liegt vor der Aktivierung** (TRD-110). Solange die
Pilotentscheidung gilt, das Modul ausgeschaltet zu lassen, entsteht daraus keine offene
Maßnahme. Die Befunde selbst werden in der privaten Sicherheitsdokumentation des Projekts
geführt, nicht hier.

## 4. Die Helios-Bump-Prüfung

Bei **jedem** Bump des Helios-Submoduls führt das Repository, das das Submodul trägt, Folgendes
aus:

```sh
# before committing a bump (checks the staged gitlink):
ops/scripts/helios-submodule-check.sh --repo . --path helios-src
# in CI (checks the committed gitlink):
ops/scripts/helios-submodule-check.sh --repo . --path helios-src --rev HEAD
```

(`ops/scripts/` liegt im Kernel-Repository; ein einbindendes Repository ruft es aus seinem
Kernel-Checkout auf.) Das Skript liest `.python-version` und `LICENSE` **aus dem Commit, den
das Superprojekt fixiert**, nicht aus dem Arbeitsverzeichnis des Submoduls, und blockiert den
Bump, es sei denn, `.python-version` nennt Python 3.13 oder ein späteres 3.x und `LICENSE` ist
der Text der Apache License 2.0 (TRD-268). Ein späteres 3.x gilt als bestätigt kompatibel,
weil es der fixierte Upstream-Commit selbst ist, der es angibt; das Skript testet Helios nicht
gegen diesen Interpreter. Die Lizenzprüfung vergleicht den Kopf, den gesamten Abschnitt der
Bedingungen (per SHA-256 nach Normalisierung der Leerraumzeichen) und den Anhang mit dem
Standardtext von Apache und schlägt fehl, wenn eine andere lizenzartige Datei (`COPYING*`,
`LICENSE-*`, eine zweite `LICENSE.*`) im Wurzelverzeichnis des fixierten Commits liegt. Exit 1
bedeutet, dass der Pin eine Prüfung nicht besteht; Exit 2 bedeutet, dass die Prüfung nicht
laufen konnte (kein Gitlink, Submodul nicht initialisiert, fixierter Commit nicht geholt).
**Beide blockieren den Bump.**

Bei Erfolg gibt es eine Protokollzeile aus; sie gehört in die Commit-Nachricht oder
PR-Beschreibung des Bumps, denn dort liegt der Nachweis je Bump. Das für den am 2026-09-25
aktuellen Pin erfasste Ergebnis:

```text
helios-submodule-check: PASS commit=c7d5e60fbf9123be13d250a2ad9dae9efd8978e3 python=3.13 licence=Apache-2.0 file=LICENSE source=HEAD
```

Die Tests des Skripts: `node --test ops/scripts/helios-submodule-check.test.mjs` (21 Fälle:
Bestehen, späteres 3.x, unter 3.13, fehlend, nicht parsbar, überlange oder mit Nullen
aufgefüllte `.python-version`, nicht Apache, Apache plus weitere Bedingungen, ein MIT-Text, der
den Apache-Kopf zitiert, eine Präambel vor dem Apache-Text, geänderte Bedingungen, zusätzlicher
Text nach dem Anhang, eine zweite Lizenzdatei, die `{}`-Anhangsvorlage von Helios, fehlende
`LICENSE`, fixierter Commit gegenüber Arbeitsverzeichnis, gestagter Bump gegenüber
`--rev HEAD`, fixierter Commit nicht geholt, Submodul nicht initialisiert, Pfad kein Gitlink,
fehlerhaftes Argument). Sie laufen außerdem bei jedem `make lint` über `make lint-compliance`.
Der Standardtext von Apache, den sie verwenden, liegt in `ops/scripts/fixtures/apache-2.0.txt`.
Mit `HELIOS_CHECK_TEST_TMP` lässt sich das Fixture-Verzeichnis aus dem temporären Systemordner
verlegen, mit `BASH_BIN` die zu verwendende Bash-Binärdatei wählen.

**Noch nicht eingebunden:** Das Helios-Submodul liegt nicht in diesem Repository, daher kann
kein Hook und kein CI-Job hier einen Bump sehen. Das Repository, das es trägt, bindet die
beiden obigen Befehle in seinen eigenen Pre-Commit-Hook und seine CI ein; bis dahin wird die
Prüfung bei jedem Bump von Hand ausgeführt.

## 5. Quellen und Entscheidungen

- **TRD-112**: Kein Produkt-, Vertriebs- oder Onboarding-Material behauptet, dass
  Online-Wahlen der Studierendenschaft in irgendeinem Bundesland rechtmäßig sind, oder stellt das
  Modul als für den satzungsgemäßen Einsatz geeignet dar; wird bei jedem Release geprüft,
  unabhängig vom Modulstatus (Abschnitt 2).
- **TRD-110**: erneute Bewertung der zwei zurückgestellten Helios-Befunde vor jedem
  satzungsgemäßen Einsatz; ruhend, solange das Modul ausgeschaltet ist (Abschnitt 3).
- **TRD-268**: Der fixierte Commit von Helios meldet Python 3.13+ und Apache-2.0, bei jedem
  Bump erneut verifiziert (Abschnitt 4). **TRD-265**: das Lizenzregister, mit dem sich die Prüfung
  dieser Seite `make lint-compliance` teilt ([licence-register.md](licence-register.md) (englisch)).
- **TRD-030**: standardmäßig deaktivierte Bereitstellung (dort verantwortet; in Abschnitt 1
  zitiert).
- **PRD-ELE-001** (Must): standardmäßig aus für neu bereitgestellte Räte; **PRD-ELE-002**
  (Should): der Hinweis auf den tatsächlichen Einsatzbereich; **PRD-TRU-009**: die Disziplin bei
  verbotenen Wörtern im Produkttext; **PRD Abschnitt 2.4**: Die Rechtmäßigkeit von
  Online-Wahlen der Studierendenschaft ist nicht festgestellt und darf nicht behauptet werden;
  **PRD Abschnitt 11.4**: Die geheime Umfrage ist eine Produkteigenschaft, keine rechtliche
  Aussage.
- **Betreiberentscheidungen:** R4-6 (satzungsgemäße Wahlen führt die Hochschule durch; geheime
  Abstimmungen und Umlaufbeschlüsse finden heute anderswo statt); R4-10 (Online-Wahlen bleiben
  vollständig optional, auch nach zwölf Monaten); R10-10 (kein Rat hält derzeit echte Wahlen
  über Helios ab; Modul aus); R13-3 (das Abstimmungsmodul ist für den Pilot an, Helios aus);
  R18 §15.1 C12 und C13 (PRD-ELE-001 auf Must angehoben; PRD-ELE-002 als Should bestätigt);
  R22-14 (die Build-Arbeit zu TASK-005 ist vor dem Angebot fällig); R23-24 (2026-09-25:
  geltende und spätere Einheiten vorgezogen und parallel ausgeführt).
