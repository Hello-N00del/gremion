# StuRaOS Mobile

The StuRaOS companion mobile app (Flutter). It authenticates against Keycloak
via OIDC (AppAuth + PKCE), talks to the StuRaOS gateway, embeds a Matrix client
for chat, and runs elections/voting through the Helios service.

All backend endpoints are supplied at **compile time** via `--dart-define`
(read with `String.fromEnvironment`). There is no runtime config file — a build
is pinned to a single environment. Release builds additionally fail fast at boot
unless every base URL is `https`/`wss` (see `assertReleaseHttps` — defined in
`lib/app.dart`, called at boot from `lib/main.dart` — fed from the constants in
`lib/app.dart`).

## Configuration (`--dart-define`)

These are the primary endpoint knobs. The names in parentheses are how each
value is surfaced as a top-level `const` in `lib/app.dart`.

| Define | Surfaced as | Meaning | Default |
| --- | --- | --- | --- |
| `GATEWAY_URL` | `gatewayUrl` | StuRaOS API gateway base URL (REST API + Matrix token exchange at `/api/auth/matrix-token` and device cleanup at `/api/auth/matrix-device`). | `http://localhost:3001` |
| `HOMESERVER_URL` | `homeserverUrl` | Matrix (Synapse) homeserver base URL the embedded Matrix client connects to. Sourced **only** from this build-time constant — the JWT `homeserver_url` claim is intentionally ignored (G-052). | `http://localhost:8009` |
| `KEYCLOAK_ISSUER` | `issuerUrl` | Keycloak realm issuer URL. OIDC auth/token/logout/JWKS endpoints are derived explicitly from this (discovery is bypassed). | `http://localhost:8082/auth/realms/sturaos` |
| `HELIOS_BASE_URL` | `heliosBaseUrl` | Helios (voting/elections) service base URL — used to build election ballot URLs. | `http://localhost:8500` |

### Keycloak endpoint override (emulator)

| Define | Meaning | Default |
| --- | --- | --- |
| `KEYCLOAK_ENDPOINT_BASE` | Read in `lib/services/auth_service.dart`. When non-empty, overrides `KEYCLOAK_ISSUER` as the base for the OIDC auth/token/logout and JWKS endpoints **and** as the expected `iss` for JWT validation. Needed on the Android emulator, where Keycloak's discovery base (`localhost:8082`) is unreachable from inside the VM — point it at the device-reachable address, e.g. `http://10.0.2.2:8082/auth/realms/sturaos`. | `` (empty — falls back to `KEYCLOAK_ISSUER`) |

### Other compile-time knobs

These also exist in the source and are read the same way:

| Define | Read in | Meaning | Default |
| --- | --- | --- | --- |
| `SYGNAL_URL` | `lib/app.dart` (`sygnalUrl`) | Matrix push gateway (Sygnal) notify endpoint, passed to `PushService`. | `http://localhost:5000/_matrix/push/v1/notify` |
| `ENABLE_SELF_HOSTED_PUSH` | `push_service.dart` | Opt-in for the self-hosted push transport (UnifiedPush + Sygnal pusher, TRD-293). Off = no push transport at all. | `false` |
| `KEYCLOAK_CLIENT_ID` | `auth_service.dart` | OIDC client id used for authorization, token, refresh, and the JWT `aud` check. | `stura-mobile` |
| `AUTH_CALLBACK_URL` | `auth_service.dart` | AppAuth redirect URI. The default is a custom URI scheme (see the G-051 security note in `auth_service.dart`). | `stura://auth/callback` |
| `MATRIX_ADMIN_ROOM_ID` | `lib/matrix/matrix_service.dart` | Room whose joined members may auto-accept invites; empty = strict mode, every invite is surfaced for manual review (G-053). | `` (empty) |
| `BRAND_PRODUCT`, `BRAND_LOGO_LETTER`, `BRAND_ORG_SHORT`, `BRAND_TERM`, `BRAND_ORG_NAME`, `BRAND_DOMAIN`, `BRAND_MATRIX_HOMESERVER` | `lib/brand.dart` | Tenant-branding strings (mirrors `gremion-ui/src/lib/brand.ts`). Defaults to HS Harz values. | `StuRaOS` / `S` / `HS Harz` / `SoSe 26` / `Studierendenrat der Hochschule Harz` / `stura.hs-harz.de` / `stura.hs-harz.de` |

## Prerequisites

Besides Flutter 3.41.x (Dart 3.11) and the Android SDK / Xcode:

- **Rust (rustup on PATH)** for Android and iOS builds: `flutter_vodozemac`
  (Matrix end-to-end encryption) compiles its Rust crate from source through
  cargokit, which calls `rustup run <toolchain> cargo build`. There are no
  prebuilt binaries for the Gradle/CocoaPods path.
- **SQLCipher as a system library for `flutter test`** on the host:
  `test/matrix/` exercises the encrypted Matrix store through
  `sqflite_common_ffi`, and package:sqlite3 looks SQLCipher up by name (see
  the `hooks:` block in `pubspec.yaml`). Debian/Ubuntu: `apt install
  libsqlcipher-dev`; macOS: `brew install sqlcipher` (on Apple Silicon
  also `export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`, since the
  library is looked up by bare name); Windows: put
  `sqlcipher.dll` and the OpenSSL `libcrypto` DLL it needs on `PATH` (e.g.
  from vcpkg `sqlcipher`). Without it only `test/matrix/matrix_store_test.dart`
  fails, with an explicit message. On devices nothing changes: the app's
  SQLCipher comes from `sqflite_sqlcipher`.
- **iOS, first macOS build:** `pod install` adds the Pods phases to
  `ios/Runner.xcodeproj/project.pbxproj` and creates `ios/Podfile.lock`;
  commit both.

## Build & run

Install dependencies:

```bash
flutter pub get
```

Run against a local stack (defaults are already localhost, so the defines are
only needed to override). On the Android emulator, add `KEYCLOAK_ENDPOINT_BASE`
pointing at `10.0.2.2` so OIDC endpoints are reachable:

```bash
flutter run \
  --dart-define=GATEWAY_URL=http://10.0.2.2:3001 \
  --dart-define=HOMESERVER_URL=http://10.0.2.2:8009 \
  --dart-define=KEYCLOAK_ISSUER=http://10.0.2.2:8082/auth/realms/sturaos \
  --dart-define=KEYCLOAK_ENDPOINT_BASE=http://10.0.2.2:8082/auth/realms/sturaos \
  --dart-define=HELIOS_BASE_URL=http://10.0.2.2:8500
```

Production / staging build (all base URLs MUST be `https`/`wss` or the boot-time
assertion throws):

```bash
flutter run \
  --dart-define=GATEWAY_URL=https://gateway.sturaos.com \
  --dart-define=HOMESERVER_URL=https://matrix.sturaos.com \
  --dart-define=KEYCLOAK_ISSUER=https://auth.sturaos.com/auth/realms/sturaos \
  --dart-define=HELIOS_BASE_URL=https://helios.sturaos.com
```

Run the tests:

```bash
flutter test
```

## `lib/` structure

```
lib/
  main.dart        Entry point: runZonedGuarded boot, vodozemac (Matrix crypto)
                   init, CrashReporter + global error hooks,
                   release-only HTTPS assertion, then runApp(StuRaApp()).
  app.dart         App composition root: the StuRaApp widget. Declares the
                   build-time URL constants, wires AuthService / ApiClient /
                   MatrixService / PushService via Provider, builds the GoRouter,
                   runs startup session-restore + token refresh + Matrix login
                   (with OLM-reset recovery), and hosts the foreground app-lock
                   gate (G-092).
  brand.dart       Tenant-branding constants (--dart-define BRAND_*).
  router/
    app_router.dart  GoRouter route table + auth-aware redirects.
  matrix/
    matrix_service.dart  Embedded Matrix client (Matrix Dart SDK 13 +
                         vodozemac), login-with-token, sync, invite handling.
    matrix_store.dart    SQLCipher-encrypted MatrixSdkDatabase + Client
                         construction (guarded by test/matrix/).
  services/
    auth_service.dart    OIDC login/refresh/logout (AppAuth + PKCE), JWT
                         verification against Keycloak JWKS, Matrix token
                         exchange via the gateway, secure-storage session.
    push_service.dart    Self-hosted push (UnifiedPush) + Sygnal pusher
                         registration; off unless ENABLE_SELF_HOSTED_PUSH=true.
                         No FCM (TASK-166).
    api_client.dart      StuRaOS gateway REST client (bearer-authenticated).
    crash_reporter.dart  Crash/error reporting sink (G-050).
  models/          Plain data models: user_session, group, calendar_event,
                   poll, election, finance_summary, nc_file, nc_file_version,
                   deck_card.
  screens/         UI screens grouped by feature: auth/login, home, chat
                   (room list/room), calendar, deck, elections, polls, groups,
                   files, settings, plus lock_screen and shell/tab_shell.
  widgets/         Shared widgets: role_guard, file_lock_badge, nc_file_tile,
                   poll_widget.
  theme/           app_theme, text_theme.
  tokens/          Design tokens: design_tokens, app_tokens, committee_hue.
```
