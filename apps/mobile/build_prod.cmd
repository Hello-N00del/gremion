@echo off
REM ============================================================
REM StuRaOS mobile — production release build (sturaos.com)
REM
REM dart-define keys verified against mobile/lib:
REM   GATEWAY_URL          app.dart:18, auth_service.dart:13
REM   KEYCLOAK_ISSUER      app.dart:24, auth_service.dart:17
REM   KEYCLOAK_ENDPOINT_BASE  auth_service.dart:40
REM   HOMESERVER_URL       app.dart:22
REM   HELIOS_BASE_URL      app.dart:26 (G-003: hoisted from elections_screen.dart so it's gated by assertReleaseHttps)
REM   SYGNAL_URL           app.dart:20  (push gateway not yet deployed —
REM                        no /_matrix/push route exists; harmless until wired)
REM   AUTH_CALLBACK_URL    auth_service.dart:31
REM
REM AUTH_CALLBACK_URL uses the `stura` scheme: it is the scheme
REM registered in android/app/build.gradle.kts
REM (manifestPlaceholders["appAuthRedirectScheme"]="stura") AND is
REM already whitelisted in the stura-mobile Keycloak client. The
REM plan's de.sturaos.app:/oauthredirect is NOT used (that scheme is
REM not registered in the Android manifest — would break SSO return).
REM ============================================================
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "FLUTTER=C:\src\flutter\bin\flutter.bat"
call "%FLUTTER%" build apk --release ^
  --dart-define=GATEWAY_URL=https://sturaos.com ^
  --dart-define=KEYCLOAK_ISSUER=https://sturaos.com/auth/realms/sturaos ^
  --dart-define=KEYCLOAK_ENDPOINT_BASE=https://sturaos.com/auth/realms/sturaos ^
  --dart-define=HOMESERVER_URL=https://sturaos.com/matrix ^
  --dart-define=HELIOS_BASE_URL=https://sturaos.com/helios ^
  --dart-define=SYGNAL_URL=https://sturaos.com/_matrix/push/v1/notify ^
  --dart-define=AUTH_CALLBACK_URL=stura://auth/callback
