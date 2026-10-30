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
| Version | 2 |
| Stand | 2026-10-30 |
| Eingabe-Digest | 6af09b2b47c53a04eb1ef746596013986f5fdb4d593dc682eba170175d48f088 |
| Massnahmen | 52 |

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
| AUTH-SSL | Keycloak: TLS-Pflicht (sslRequired) | __SSL_REQUIRED__ | `docker/keycloak/realm-export.base.json` |
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
| HDR-CSP-BASE-URI | Content-Security-Policy: base-uri | base-uri 'self' | `gremion-ui/svelte.config.js` |
| HDR-CSP-CONNECT-SRC | Content-Security-Policy: connect-src | connect-src 'self' https: wss: | `gremion-ui/svelte.config.js` |
| HDR-CSP-DEFAULT-SRC | Content-Security-Policy: default-src | default-src 'self' | `gremion-ui/svelte.config.js` |
| HDR-CSP-FONT-SRC | Content-Security-Policy: font-src | font-src 'self' data: | `gremion-ui/svelte.config.js` |
| HDR-CSP-FORM-ACTION | Content-Security-Policy: form-action | form-action 'self' | `gremion-ui/svelte.config.js` |
| HDR-CSP-FRAME-ANCESTORS | Content-Security-Policy: frame-ancestors | frame-ancestors 'self' | `gremion-ui/src/hooks.server.ts` |
| HDR-CSP-FRAME-SRC | Content-Security-Policy: frame-src | frame-src 'self' | `gremion-ui/svelte.config.js` |
| HDR-CSP-IMG-SRC | Content-Security-Policy: img-src | img-src 'self' data: blob: https: | `gremion-ui/svelte.config.js` |
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
| LOG-LOKI-AUDIT | Loki: Klasse audit | 27d | `docker/loki/loki.yaml` |
| LOG-LOKI-DEFAULT | Loki: Standard-Aufbewahrung | 14d | `docker/loki/loki.yaml` |
| LOG-LOKI-FINANCE | Loki: Klasse finance | 27d | `docker/loki/loki.yaml` |
| LOG-LOKI-SECURITY | Loki: Klasse security | 27d | `docker/loki/loki.yaml` |
| LOG-TEMPO-BLOCK | Tempo: Trace-Aufbewahrung | 168h | `docker/tempo/tempo.yaml` |

### Module

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| MOD-BOARD | Modul board: Export bei Deaktivierung | pg_dump, Aufbewahrungsprofil rp-brd-module-data | `modules/board/module.json` |
| MOD-CALENDAR | Modul calendar: Export bei Deaktivierung | pg_dump, Aufbewahrungsprofil rp-cal-module-data | `modules/calendar/module.json` |
| MOD-CONTENT | Modul content: Export bei Deaktivierung | pg_dump, Aufbewahrungsprofil rp-pub-module-data | `modules/content/module.json` |
| MOD-FINANCE | Modul finance: Export bei Deaktivierung | pg_dump, Aufbewahrungsprofil rp-fin-module-data | `modules/finance/module.json` |
| MOD-PUBLISHING | Modul publishing: Export bei Deaktivierung | pg_dump, Aufbewahrungsprofil rp-nws-module-data | `modules/publishing/module.json` |
| MOD-VAULT | Modul vault: Export bei Deaktivierung | pg_dump, Aufbewahrungsprofil rp-pwd-module-data | `modules/vault/module.json` |

### Aufbewahrung

| Id | Massnahme | Wert | Quelle |
|---|---|---|---|
| RET-RC-LOG-ACC | Protokollklasse Access (Zugriffsprotokolle) | Regelfrist 14 d, Obergrenze 30 d | `docs/compliance/retention-catalogue.md` |
| RET-RC-LOG-APP | Protokollklasse Application (Anwendungsprotokolle) | Regelfrist 30 d, Obergrenze 30 d | `docs/compliance/retention-catalogue.md` |
| RET-RC-LOG-AUD | Protokollklasse Audit / operator access (Audit- und Betreiberzugriffsprotokolle) | Regelfrist 27 d, Obergrenze 30 d | `docs/compliance/retention-catalogue.md` |
| RET-RC-LOG-FIN | Protokollklasse Finance (Finanzprotokolle) | Regelfrist 27 d, Obergrenze 30 d | `docs/compliance/retention-catalogue.md` |
| RET-RC-LOG-SEC | Protokollklasse Security (Sicherheitsprotokolle), including identity-provider login and admin events | Regelfrist 27 d, Obergrenze 30 d | `docs/compliance/retention-catalogue.md` |
| RET-RC-LOG-TRC | Protokollklasse Trace (trace store) | Regelfrist 7 d, Obergrenze 14 d | `docs/compliance/retention-catalogue.md` |
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
| HDR-CSP-BASE-URI | kit.csp |
| HDR-CSP-CONNECT-SRC | kit.csp |
| HDR-CSP-DEFAULT-SRC | kit.csp |
| HDR-CSP-FONT-SRC | kit.csp |
| HDR-CSP-FORM-ACTION | kit.csp |
| HDR-CSP-FRAME-ANCESTORS | CSP_HEADER_VALUE |
| HDR-CSP-FRAME-SRC | kit.csp |
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
| LOG-LOKI-AUDIT | limits_config.retention_stream |
| LOG-LOKI-DEFAULT | limits_config.retention_period |
| LOG-LOKI-FINANCE | limits_config.retention_stream |
| LOG-LOKI-SECURITY | limits_config.retention_stream |
| LOG-TEMPO-BLOCK | compactor.compaction.block_retention |
| MOD-BOARD | runtime.export |
| MOD-CALENDAR | runtime.export |
| MOD-CONTENT | runtime.export |
| MOD-FINANCE | runtime.export |
| MOD-PUBLISHING | runtime.export |
| MOD-VAULT | runtime.export |
| RET-RC-LOG-ACC | Abschnitt 4.1, Zeile RC-LOG-ACC |
| RET-RC-LOG-APP | Abschnitt 4.1, Zeile RC-LOG-APP |
| RET-RC-LOG-AUD | Abschnitt 4.1, Zeile RC-LOG-AUD |
| RET-RC-LOG-FIN | Abschnitt 4.1, Zeile RC-LOG-FIN |
| RET-RC-LOG-SEC | Abschnitt 4.1, Zeile RC-LOG-SEC |
| RET-RC-LOG-TRC | Abschnitt 4.1, Zeile RC-LOG-TRC |
| RET-STATUS | Status-Zeile |

## 3. Versionsverlauf

| Version | Datum | Digest | Geaenderte Massnahmen |
|---|---|---|---|
| 1 | 2026-10-27 | c58de9cf437fac3f72ed3ac2227ae755878a89088c8c9ba330f21ad56e980aba | erste Fassung |
| 2 | 2026-10-30 | 6af09b2b47c53a04eb1ef746596013986f5fdb4d593dc682eba170175d48f088 | HDR-CACHE-CONTROL, HDR-CSP-SCRIPT-SRC |
