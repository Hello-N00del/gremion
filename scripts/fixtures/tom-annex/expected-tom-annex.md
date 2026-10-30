# TOM-Annex (technische und organisatorische Massnahmen, Art. 32 DSGVO)

> **Erzeugt** von `scripts/gen-tom-annex.mjs` aus den unten zitierten Quelldateien (TRD-140, TRD-141).
> Nicht von Hand aendern: eine Aenderung an einer Quelle wird im Release-Lint (`--check`) als
> veralteter Annex abgewiesen; neu erzeugen mit `node scripts/gen-tom-annex.mjs`. Jede Zeile nennt ihre
> Quelle; was dort nicht steht, steht hier nicht. Der Annex gibt den Stand der Konfiguration im Repository
> wieder, nicht den Betriebszustand eines Rats. Er ersetzt weder die Abschnitte 4a und 5 in
> `docs/compliance/controller-processor-split.md` noch deren offene Punkte (`TBD`: Festplattenverschluesselung,
> Offsite-Ziel, Backup-Gate), und er wird dem Auftragsverarbeitungsvertrag in der zum Unterschriftsdatum
> aktuellen Fassung beigefuegt (TRD-142).

| | |
|---|---|
| Version | 1 |
| Stand | 2026-10-27 |
| Eingabe-Digest | 57547ecb331264d562ef825a92e83917659efd372d8ff61d88351371b2889274 |
| Massnahmen | 36 |

Der Digest ist SHA-256 ueber die Liste (Id, Wert, Quelle, Fundstelle) aller Massnahmen unten.

## 1. Massnahmen

### Zugriff und Authentisierung

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| AUTH-ACR | Keycloak: Zuordnung ACR zu Vertrauensniveau | {"loa1":1,"loa2":2} | `docker/keycloak/realm-export.base.json` |
| AUTH-ATL | Keycloak: Lebensdauer Access-Token (s) | 600 | `docker/keycloak/realm-export.base.json` |
| AUTH-BRUTE | Keycloak: Schutz gegen Brute-Force | true | `docker/keycloak/realm-export.base.json` |
| AUTH-FAILS | Keycloak: Fehlversuche bis Sperre | 5 | `docker/keycloak/realm-export.base.json` |
| AUTH-IDLE | Keycloak: SSO-Leerlaufzeit (s) | 1800 | `docker/keycloak/realm-export.base.json` |
| AUTH-MAX | Keycloak: SSO-Hoechstdauer (s) | 43200 | `docker/keycloak/realm-export.base.json` |
| AUTH-OTP-DIGITS | Keycloak: zweiter Faktor, Stellen | 6 | `docker/keycloak/realm-export.base.json` |
| AUTH-OTP-PERIOD | Keycloak: zweiter Faktor, Periode (s) | 30 | `docker/keycloak/realm-export.base.json` |
| AUTH-OTP-TYPE | Keycloak: zweiter Faktor, Verfahren | totp | `docker/keycloak/realm-export.base.json` |
| AUTH-SSL | Keycloak: TLS-Pflicht (sslRequired) | external | `docker/keycloak/realm-export.base.json` |
| AUTH-STEPUP | Step-up fuer erhoehte Handlungen | Vertrauensniveau Passwort 1, Step-up 2 | `gremion-ui/src/lib/auth/step-up.ts` |
| AUTH-WAIT | Keycloak: maximale Sperrzeit (s) | 900 | `docker/keycloak/realm-export.base.json` |

### Datensicherung

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| BAK-CRYPT | Verschluesselung des Backup-Repositorys | restic-Repository, durch RESTIC_PASSWORD verschluesselt | `scripts/backup.sh` |
| BAK-LOCAL | Lokale Aufbewahrung der Sicherungen | 30 d (Standard) | `scripts/backup.sh` |

### Transport und Browserschutz

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| HDR-CACHE-CONTROL | Header Cache-Control (HTML-Seiten) | no-store | `gremion-ui/src/hooks.server.ts` |
| HDR-CSP-DEFAULT-SRC | Content-Security-Policy: default-src | default-src 'self' | `gremion-ui/svelte.config.js` |
| HDR-CSP-FRAME-ANCESTORS | Content-Security-Policy: frame-ancestors | frame-ancestors 'self' | `gremion-ui/src/hooks.server.ts` |
| HDR-CSP-IMG-SRC | Content-Security-Policy: img-src | img-src 'self' data: https: | `gremion-ui/svelte.config.js` |
| HDR-CSP-OBJECT-SRC | Content-Security-Policy: object-src | object-src 'none' | `gremion-ui/svelte.config.js` |
| HDR-CSP-SCRIPT-SRC | Content-Security-Policy: script-src | script-src 'self' 'nonce-<pro Antwort>' | `gremion-ui/svelte.config.js` |
| HDR-CSP-STYLE-SRC | Content-Security-Policy: style-src | style-src 'self' 'unsafe-inline' | `gremion-ui/svelte.config.js` |
| HDR-REFERRER-POLICY | Header Referrer-Policy | strict-origin-when-cross-origin | `gremion-ui/src/hooks.server.ts` |
| HDR-X-CONTENT-TYPE-OPTIONS | Header X-Content-Type-Options | nosniff | `gremion-ui/src/hooks.server.ts` |

### Protokolle

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| LOG-KC-ADMIN | Keycloak: Admin-Ereignisse protokolliert | true | `docker/keycloak/realm-export.base.json` |
| LOG-KC-ADMIN-EXP | Keycloak: Ablauf Admin-Ereignisse (s) | 2505600 | `docker/keycloak/realm-export.base.json` |
| LOG-KC-EVENTS | Keycloak: Anmeldeereignisse protokolliert | true | `docker/keycloak/realm-export.base.json` |
| LOG-KC-EXP | Keycloak: Ablauf Anmeldeereignisse (s) | 2505600 | `docker/keycloak/realm-export.base.json` |
| LOG-LOKI-ACCESS | Loki: Klasse access | 14d | `docker/loki/loki.yaml` |
| LOG-LOKI-APPLICATION | Loki: Klasse application | 28d | `docker/loki/loki.yaml` |
| LOG-LOKI-DEFAULT | Loki: Standard-Aufbewahrung | 14d | `docker/loki/loki.yaml` |
| LOG-TEMPO-BLOCK | Tempo: Trace-Aufbewahrung | 168h | `docker/tempo/tempo.yaml` |

### Module

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| MOD-BOARD | Modul board: Export bei Deaktivierung | pg_dump, Aufbewahrungsprofil rp-brd-module-data | `modules/board/module.json` |
| MOD-FILES | Modul files: Export bei Deaktivierung | tar, Aufbewahrungsprofil rp-fil-module-data | `modules/files/module.json` |

### Aufbewahrung

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| RET-RC-LOG-ACC | Protokollklasse Access (Zugriffsprotokolle) | Regelfrist 14 d, Obergrenze 30 d | `docs/compliance/retention-catalogue.md` |
| RET-RC-LOG-APP | Protokollklasse Application (Anwendungsprotokolle) | Regelfrist 30 d, Obergrenze 30 d | `docs/compliance/retention-catalogue.md` |
| RET-STATUS | Ableitungsstand des Fristenkatalogs | DRAFT vom 2026-09-25 | `docs/compliance/retention-catalogue.md` |

## 2. Fundstellen

| Id | Fundstelle in der Quelle |
|---|---|
| AUTH-ACR | attributes.acr.loa.map |
| AUTH-ATL | accessTokenLifespan |
| AUTH-BRUTE | bruteForceProtected |
| AUTH-FAILS | failureFactor |
| AUTH-IDLE | ssoSessionIdleTimeout |
| AUTH-MAX | ssoSessionMaxLifespan |
| AUTH-OTP-DIGITS | otpPolicyDigits |
| AUTH-OTP-PERIOD | otpPolicyPeriod |
| AUTH-OTP-TYPE | otpPolicyType |
| AUTH-SSL | sslRequired |
| AUTH-STEPUP | LOA |
| AUTH-WAIT | maxFailureWaitSeconds |
| BAK-CRYPT | RESTIC_PASSWORD |
| BAK-LOCAL | BACKUP_LOCAL_RETENTION_DAYS |
| HDR-CACHE-CONTROL | cspGuard |
| HDR-CSP-DEFAULT-SRC | kit.csp |
| HDR-CSP-FRAME-ANCESTORS | CSP_HEADER_VALUE |
| HDR-CSP-IMG-SRC | kit.csp |
| HDR-CSP-OBJECT-SRC | kit.csp |
| HDR-CSP-SCRIPT-SRC | kit.csp |
| HDR-CSP-STYLE-SRC | kit.csp |
| HDR-REFERRER-POLICY | cspGuard |
| HDR-X-CONTENT-TYPE-OPTIONS | cspGuard |
| LOG-KC-ADMIN | adminEventsEnabled |
| LOG-KC-ADMIN-EXP | attributes.adminEventsExpiration |
| LOG-KC-EVENTS | eventsEnabled |
| LOG-KC-EXP | eventsExpiration |
| LOG-LOKI-ACCESS | limits_config.retention_stream |
| LOG-LOKI-APPLICATION | limits_config.retention_stream |
| LOG-LOKI-DEFAULT | limits_config.retention_period |
| LOG-TEMPO-BLOCK | compactor.compaction.block_retention |
| MOD-BOARD | runtime.export |
| MOD-FILES | runtime.export |
| RET-RC-LOG-ACC | Abschnitt 4.1, Zeile RC-LOG-ACC |
| RET-RC-LOG-APP | Abschnitt 4.1, Zeile RC-LOG-APP |
| RET-STATUS | Status-Zeile |

## 3. Versionsverlauf

| Version | Datum | Digest | Geaenderte Massnahmen |
|---|---|---|---|
| 1 | 2026-10-27 | 57547ecb331264d562ef825a92e83917659efd372d8ff61d88351371b2889274 | erste Fassung |
