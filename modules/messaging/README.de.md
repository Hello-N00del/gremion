<!-- i18n-sync: source=README.md sha256=c7ddf09fbd91729e16c1b5bb238015e3caf17bd7580814af7ad9b2b003455f06 -->
[English](./README.md) | **Deutsch**

# messaging

Chaträume und Videoanrufe. Die Kernel-App liefert die Seiten und die API; der Leaf ist ein
dünner, zustandsloser Proxy zum Matrix-Homeserver (Synapse) und zu LiveKit, der im Namen der
jeweiligen Person mit deren eigenem Matrix-Token auftritt. Das Verzeichnis enthält außerdem das
Synapse-Image und dessen Konfiguration, sodass der Homeserver mit dem Kernel-Baum ausgeliefert
wird. Status: **unterstützt** ([docs/modules.de.md](../../docs/modules.de.md)).

| | |
|---|---|
| Verzeichnis / `module.json`-ID | `messaging` |
| Manifest-ID (Schlüssel in `config.modules`) | `messages` |
| Paket | `messages-service` |
| Navigation | Segment `/messages` (Mindestrolle: Mitglied); ein zusätzlicher Eintrag `/messages/manage` ("Raeume", Administrator:innen des Rats) |
| Leaf-Service | ja, zustandslos (keine Datenbank, kein NATS, kein Scheduler), lauscht auf `PORT` (Standard 8080) |
| Plattform-Server | Synapse, mit PostgreSQL-Dienst `messaging-postgres` und Datenbank `synapse` (`module.json`) |

## Aufbau

| Pfad | Inhalt |
|---|---|
| `app/` | Die In-Process-Hälfte, über `gremion-ui/src/` gelegt: Seiten, API-Routen, Endpunkte für Element Call und LiveKit, Push-Endpunkt, Matrix-Token-Routen, Backend-Port, Manifest. |
| `src/` | Der Leaf: `http/` (Server, Guard, Abhängigkeiten), `matrix/` (Client), `operations.ts`. |
| `synapse/` | Das Synapse-Image: `Dockerfile`, Vorlage `homeserver.yaml`, `render-homeserver.sh`, `entrypoint.sh`, `bootstrap.sh`, `db-preflight.py`, `inject-jwt-key.py`, `healthcheck.sh`, `log.config`, `postgres-init/10-synapse-db.sh` sowie ein eigenes `test/`. |
| `test/` | Unit- und Integrationstests des Leafs. |

## Routen und API-Oberfläche

Kernel-App (`app/routes/`):

| Route | Methoden |
|---|---|
| `/messages`, `/messages/manage` | Seiten |
| `/api/messages/sync` | GET |
| `/api/messages/rooms` | GET, POST |
| `/api/messages/rooms/[roomId]` | PATCH, DELETE |
| `/api/messages/rooms/[roomId]/{archive,read}` | POST |
| `/api/messages/rooms/[roomId]/messages` | GET, POST |
| `/api/messages/rooms/[roomId]/media` | GET, POST |
| `/api/messages/rooms/[roomId]/typing` | PUT |
| `/api/messages/rooms/[roomId]/unit` | GET |
| `/api/auth/matrix-token` | GET |
| `/api/auth/matrix-device` | DELETE |
| `/api/video/token`, `/api/video/meeting-room`, `/api/video/matrix-widget-action` | POST |
| `/api/video/openid-token` | GET |
| `/element-call/[...path]` | GET |
| `/livekit/jwt/get_token`, `/livekit/jwt/sfu/get` | POST |
| `/api/internal/push` | POST (Callback für Push-Benachrichtigungen) |

Leaf (`src/operations.ts`), Guard mit gemeinsamem Geheimnis außer bei `/healthz`, alle `POST`:
`/api/v1/messages/{sync,rooms,list,send,read,typing}`, `/api/v1/messages/media/{download,upload}`,
`/api/v1/video/{token,meeting-room,openid-token,widget-action}` und
`/api/v1/auth/{matrix-token,matrix-device}`.

## Migrationen

Keine für die eigenen Daten des Moduls (`database: null`). Die Synapse-Datenbank legt das
initdb-Skript `synapse/postgres-init/10-synapse-db.sh` beim ersten Start von
`messaging-postgres` an: eine Rolle `synapse` ohne Superuser-Recht und eine Datenbank `synapse`
mit der Kollation `C`. Das Skript bricht die erste Initialisierung ab, wenn
`SYNAPSE_DB_PASSWORD` leer ist. Bei jedem Start von Synapse prüft `db-preflight.py` die
Kollation und die PostgreSQL-Hauptversion.

## Konfiguration

Kernel-App und Leaf:

| Variable | Bedeutung |
|---|---|
| `MESSAGES_BACKEND` | `inprocess` (Standard) oder `service`; jeder andere Wert wird abgelehnt. |
| `MESSAGES_SERVICE_URL`, `INTERNAL_MESSAGES_SECRET` | Basis-URL des Leafs und gemeinsames Geheimnis (`x-internal-auth`). |
| `MATRIX_URL` | Interne URL des Homeservers; ist sie nicht gesetzt, gibt der Leaf eine Warnung aus und weicht auf `http://matrix:8008` aus. |
| `MATRIX_PUBLIC_URL` | URL des Homeservers, wie der Browser sie erreicht. |
| `SYNAPSE_SERVER_NAME`, `SYNAPSE_ADMIN_TOKEN`, `SYNAPSE_ADMIN_BOT_USER_ID` | Name des Homeservers, Admin-Zugriffstoken, ID des Bots für die Raumverwaltung. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Zugangsdaten für LiveKit-Beitrittstokens. Pflichtgeheimnis: Der Leaf startet nicht, wenn `LIVEKIT_API_SECRET` oder `SYNAPSE_ADMIN_TOKEN` nicht gesetzt oder leer ist. |
| `ELEMENT_CALL_INTERNAL_URL`, `PUBLIC_ELEMENT_CALL_URL` | Element Call, intern und aus Sicht des Browsers. |
| `INTERNAL_PUSH_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON` | Geheimnis des Push-Endpunkts; Dienstkonto für Firebase Cloud Messaging. |
| `AUTH_SECRET`, `PUBLIC_BASE_URL`, `PORT` | Sitzungsgeheimnis, öffentliche Basis-URL, Listen-Port des Leafs. |

Synapse-Container (`docker-compose.yml`, Dienst `matrix`): `SYNAPSE_SERVER_NAME` und
`MATRIX_PUBLIC_URL` (beide aus `PLATFORM_DOMAIN` abgeleitet), `SYNAPSE_DB_*`,
`SYNAPSE_KEYCLOAK_ISSUER_URL`, `SYNAPSE_KEYCLOAK_FETCH_URL`, `SYNAPSE_OIDC_CLIENT_SECRET`,
`SYNAPSE_REGISTRATION_SHARED_SECRET` (wird nur bei einem Bootstrap-Start gerendert),
`SYNAPSE_ADMIN_BOT_USER_ID`, `SYNAPSE_BOOTSTRAP_MODE`, `SYNAPSE_KC_MAX`. Der Render-Schritt
lehnt einen leeren Issuer und jede andere Datenbank als PostgreSQL ab.

Der PostgreSQL-Server des Moduls ist `messaging-postgres`, der Homeserver ist `matrix`; beide
laufen unter dem Compose-Profil `messaging` (`MESSAGING_PG_USER`, `MESSAGING_PG_PASSWORD`,
`SYNAPSE_DB_PASSWORD`).

## Externe Dienste

- Matrix/Synapse: wird aus diesem Verzeichnis gebaut und vom Profil `messaging` gestartet.
- LiveKit und Element Call für Video: in den Compose-Dateien im Wurzelverzeichnis des
  Repositorys nicht definiert; Betreiber:innen stellen sie bereit.
- Keycloak als OpenID-Provider für Synapse.
- Firebase Cloud Messaging, nur für Push-Benachrichtigungen.

## Aktivieren und Deaktivieren

- Build: im Standard-Build enthalten.
- Pro Kunde: `--enable messaging` beim Anlegen (die Katalog-ID ist die `module.json`-ID; der
  unten genannte Instanzschlüssel ist die Manifest-ID), oder über die Anfragen `enable_module`
  und `disable_module` des Panels ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md), englisch).
  Die Chat-Umfrage des Moduls votes benötigt das Profil `messaging`
  ([pilot/module-defaults.de.md](../../docs/pilot/module-defaults.de.md)).
- Instanzeinstellung: `config.modules.messages = false` beantwortet `/messages` mit der Seite
  für deaktivierte Module, `/api/messages` und `/api/video` mit einem bloßen 403 ohne Inhalt und entfernt
  beide Navigationseinträge.
- Leaf: `docker build -f modules/messaging/Dockerfile .` im Wurzelverzeichnis des Repositorys.
  Synapse: `docker build modules/messaging/synapse` (der Compose-Dienst baut es).

## Tests

- `pnpm --filter messages-service test` (Unit, `test/`), `test:integration`, `typecheck`.
- Tests des Synapse-Images: `node --test modules/messaging/synapse/test/`;
  `scripts/check-synapse-stack.mjs` prüft die Verdrahtung des Stacks.
  `synapse/test/scratch-proof.sh` ist ein Shell-Nachweis, der eine Container-Laufzeit
  benötigt (für diese README nicht ausgeführt).
- Tests unter `app/` liegen neben dem Code und werden vom Skript `test` des Pakets nicht
  erfasst.

## Aus dem Code nicht belegt

- Ob die Synapse-Tests unter `synapse/test/` von der CI ausgeführt werden, wurde nicht
  geprüft.
- Die genaue Menge der Keycloak-Objekte, die Synapse benötigt, wird außerhalb dieses
  Verzeichnisses angelegt.
