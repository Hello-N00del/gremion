// mobile/lib/app.dart
import 'dart:convert';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'brand.dart';
import 'router/app_router.dart';
import 'screens/lock_screen.dart';
import 'services/auth_service.dart';
import 'services/api_client.dart';
import 'matrix/matrix_service.dart';
import 'services/push_service.dart';
import 'theme/app_theme.dart';

// Base URL constants — shared with main.dart (boot-time HTTPS assertion lives
// there). Keep these as top-level `const` so they're usable at compile time.
const gatewayUrl = String.fromEnvironment('GATEWAY_URL',
    defaultValue: 'http://localhost:3001');
const sygnalUrl = String.fromEnvironment('SYGNAL_URL',
    defaultValue: 'http://localhost:5000/_matrix/push/v1/notify');
const homeserverUrl = String.fromEnvironment('HOMESERVER_URL',
    defaultValue: 'http://localhost:8009');
const issuerUrl = String.fromEnvironment('KEYCLOAK_ISSUER',
    defaultValue: 'http://localhost:8082/auth/realms/sturaos');
// #261: optional transport override for the OIDC endpoints (see
// auth_service.dart). When set it steers the auth/token/end-session/JWKS URLs,
// so it MUST also pass the boot-time release-HTTPS gate — main.dart adds it to
// the assertReleaseHttps map when non-empty. Default '' = not overridden.
const endpointBase =
    String.fromEnvironment('KEYCLOAK_ENDPOINT_BASE', defaultValue: '');
const heliosBaseUrl = String.fromEnvironment('HELIOS_BASE_URL',
    defaultValue: 'http://localhost:8500');

/// Validates every base URL has an https/wss scheme; throws on the first
/// offender. Pure — does not consult kReleaseMode — so it is directly
/// testable. Use [assertReleaseHttps] from main.dart as the boot-time gate.
void validateHttpsSchemes(Map<String, String> labelledUrls) {
  for (final entry in labelledUrls.entries) {
    final scheme = Uri.tryParse(entry.value)?.scheme;
    if (scheme != 'https' && scheme != 'wss') {
      throw ArgumentError.value(
        entry.value,
        entry.key,
        'must be https or wss in release builds (got $scheme)',
      );
    }
  }
}

/// In release mode, every base URL must be HTTPS/WSS. Delegates to
/// [validateHttpsSchemes] so the scheme-checking logic is exercised by tests.
void assertReleaseHttps(Map<String, String> labelledUrls) {
  if (!kReleaseMode) return;
  validateHttpsSchemes(labelledUrls);
}

class StuRaApp extends StatefulWidget {
  const StuRaApp({super.key});
  @override
  State<StuRaApp> createState() => _StuRaAppState();
}

// G-092 — foreground app-lock gate (PR 6 T6.10). Replaces the earlier TODO.
//
// A [WidgetsBindingObserver] flips [_locked] true when the app goes to the
// background/inactive; the MaterialApp.router `builder` swaps the visible
// surface for [LockScreen] until the user taps "Entsperren". The gate is
// UI-only: navigation state (GoRouter) survives underneath, and the
// Keycloak/Matrix session is untouched (it refreshes via AuthService.refresh()
// as today). A future iteration can layer local_auth/biometric onto onUnlock.
class _StuRaAppState extends State<StuRaApp> with WidgetsBindingObserver {
  late final AuthService _auth;
  late final StuRaOSApiClient _api;
  late final MatrixService _matrix;
  late final PushService _push;
  late final GoRouter _router;

  /// #261: injected HTTP client for the OLM-recovery gateway calls below, so
  /// they go through one closeable client with a timeout (mirrors the
  /// api_client/_http seam) instead of the raw top-level http.get/http.delete.
  final http.Client _httpClient = http.Client();

  /// Whether the foreground lock gate is showing (G-092).
  bool _locked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _auth = AuthService();
    _api = StuRaOSApiClient(baseUrl: gatewayUrl, accessToken: '');
    _matrix = MatrixService(homeserverUrl: homeserverUrl);
    _push = PushService(sygnalUrl: sygnalUrl);
    _router = buildRouter(_auth);
    _init();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Lock as soon as the app leaves the foreground so the last frame can't be
    // read from the OS app-switcher snapshot. Only lock an authenticated
    // session — there is nothing to protect on the login screen.
    if ((state == AppLifecycleState.paused ||
            state == AppLifecycleState.inactive) &&
        _auth.isAuthenticated &&
        !_locked) {
      setState(() => _locked = true);
    }
  }

  Future<void> _init() async {
    try {
      await _matrix.init();
      final hasSession = await _auth.restoreSession();
      if (hasSession) {
        var session = _auth.session!;
        _api.accessToken = session.accessToken;

        // Always do a silent token refresh on startup — the Keycloak access token and
        // Synapse matrix token are short-lived (~5 min) and are almost always expired
        // between sessions. _persistTokens re-fetches the matrix token + device ID.
        try {
          await _auth.refresh();
          session = _auth.session!;
          _api.accessToken = session.accessToken;
          // G-091: log only presence + a truncated device-id prefix —
          // matrix tokens are sensitive (full bearer creds for Synapse),
          // device-ids are not strictly secret but the prefix is enough to
          // disambiguate concurrent devices without exposing the full id.
          developer.log(
            'Startup refresh: matrixTokenPresent=${session.matrixToken.isNotEmpty}, deviceIdPrefix=${_redactDeviceId(session.matrixDeviceId)}',
            name: 'StuRaApp',
          );
        } catch (e) {
          // G-091: route the offline-refresh diagnostic via developer.log
          // (auto-filtered in release). `e` here is typically a SocketException
          // or HTTP-level error — never a credential — but we still pass it
          // as the structured `error` field rather than interpolating into
          // the message body.
          developer.log('Startup refresh failed (offline?)',
              name: 'StuRaApp', error: e);
        }

        if (session.matrixToken.isNotEmpty && session.matrixUserId.isNotEmpty) {
          await _initMatrix(session.matrixToken, session.matrixUserId,
              session.matrixDeviceId, session.accessToken);
        } else {
          developer.log(
            'Matrix init skipped: no token after refresh attempt.',
            name: 'StuRaApp',
          );
        }
      }
      _auth.addListener(_onAuthChange);
    } catch (e, st) {
      developer.log('init failed', name: 'StuRaApp', error: e, stackTrace: st);
    }
  }

  /// G-091 helper: redact a Matrix device id to its first 4 chars + ellipsis.
  /// Device ids are not strictly credentials but full-string disclosure in
  /// startup logs is more than the diagnostic needs.
  static String _redactDeviceId(String deviceId) {
    if (deviceId.isEmpty) return '<empty>';
    if (deviceId.length <= 4) return '${deviceId[0]}…';
    return '${deviceId.substring(0, 4)}…';
  }

  /// Initialise the Matrix client. Handles the [MatrixOlmResetRequired] recovery
  /// path: deletes the stale Synapse device via the gateway, fetches a fresh
  /// token (no device_id so Synapse creates a clean session), then retries.
  Future<void> _initMatrix(
    String matrixToken,
    String matrixUserId,
    String matrixDeviceId,
    String keycloakAccessToken,
  ) async {
    try {
      await _matrix.loginWithToken(
        matrixToken,
        matrixUserId,
        deviceId: matrixDeviceId.isNotEmpty ? matrixDeviceId : null,
      );
    } on MatrixOlmResetRequired catch (reset) {
      // G-091: developer.log so this OLM-recovery diagnostic survives in
      // debug but is auto-filtered in release.
      developer.log(
        'OLM reset required for device ${_redactDeviceId(reset.staleDeviceId)} — deleting Synapse device and retrying.',
        name: 'StuRaApp',
      );
      // Step 1: delete the stale Synapse device via the gateway admin endpoint.
      try {
        await _httpClient
            .delete(
              Uri.parse('$gatewayUrl/api/auth/matrix-device'),
              headers: {
                'Authorization': 'Bearer $keycloakAccessToken',
                'Content-Type': 'application/json',
              },
              body: jsonEncode({'deviceId': reset.staleDeviceId}),
            )
            .timeout(const Duration(seconds: 10));
      } catch (e) {
        developer.log('Device deletion failed (continuing anyway)',
            name: 'StuRaApp', error: e);
      }
      // Step 2: fetch a fresh Synapse token (no device_id → clean Synapse session).
      try {
        final resp = await _httpClient.get(
          Uri.parse('$gatewayUrl/api/auth/matrix-token'),
          headers: {'Authorization': 'Bearer $keycloakAccessToken'},
        ).timeout(const Duration(seconds: 10));
        if (resp.statusCode == 200) {
          final body = jsonDecode(resp.body) as Map<String, dynamic>;
          if (body['success'] == true) {
            final newToken = (body['data']?['matrixToken'] as String?) ?? '';
            final newUserId =
                (body['data']?['matrixUserId'] as String?) ?? matrixUserId;
            final newDeviceId =
                (body['data']?['matrixDeviceId'] as String?) ?? '';
            if (newToken.isNotEmpty) {
              await _matrix.loginWithToken(newToken, newUserId,
                  deviceId: newDeviceId.isNotEmpty ? newDeviceId : null);
              matrixToken = newToken;
              matrixUserId = newUserId;
            }
          }
        }
      } catch (e) {
        developer.log('OLM recovery token fetch failed',
            name: 'StuRaApp', error: e);
        return;
      }
    }
    try {
      _push.configure(
        homeserverUrl: homeserverUrl,
        matrixAccessToken: matrixToken,
        matrixUserId: matrixUserId,
      );
      await _push.init();
    } catch (e) {
      developer.log('Push init failed (non-fatal)', name: 'StuRaApp', error: e);
    }
  }

  void _onAuthChange() {
    if (_auth.isAuthenticated) {
      final session = _auth.session!;
      _api.accessToken = session.accessToken;
      // Init Matrix on first login (token not available during restoreSession).
      if (!_matrix.isSyncing &&
          session.matrixToken.isNotEmpty &&
          session.matrixUserId.isNotEmpty) {
        _initMatrix(
          session.matrixToken,
          session.matrixUserId,
          session.matrixDeviceId,
          session.accessToken,
        ).catchError((Object e) {
          developer.log('Matrix init on auth change failed',
              name: 'StuRaApp', error: e);
        });
      }
    } else {
      // #233: full logout. AuthService.logout() has already revoked the
      // Keycloak session and wiped secure storage; tear down the app-owned
      // services that still hold live credentials in memory / on disk. Runs
      // detached — the settings-screen tap only awaits AuthService.logout().
      _teardownSession().catchError((Object e) {
        developer.log('Logout teardown failed', name: 'StuRaApp', error: e);
      });
    }
  }

  /// #233: orchestrated logout teardown for the four app-owned services.
  /// Ordered for correctness: push pushers are removed FIRST (while the Matrix
  /// token is still valid), THEN the Matrix session is revoked, THEN its
  /// on-disk DB (token + OLM keys + message cache) is deleted, THEN the
  /// in-memory gateway bearer token is dropped. Each step is independently
  /// guarded so one failure (e.g. offline) never blocks the rest.
  Future<void> _teardownSession() async {
    try {
      await _push.deregisterAll();
    } catch (e) {
      developer.log('Push deregister failed', name: 'StuRaApp', error: e);
    }
    try {
      await _matrix.logout();
    } catch (e) {
      developer.log('Matrix logout failed', name: 'StuRaApp', error: e);
    }
    try {
      await _matrix.deleteLocalDatabase();
    } catch (e) {
      developer.log('Matrix DB delete failed', name: 'StuRaApp', error: e);
    }
    _api.accessToken = '';
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _auth.removeListener(_onAuthChange);
    _httpClient.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: _auth),
        ChangeNotifierProvider.value(value: _matrix),
        Provider.value(value: _api),
        Provider.value(value: _push),
      ],
      child: MaterialApp.router(
        title: Brand.product,
        theme: lightTheme(),
        darkTheme: darkTheme(),
        themeMode: ThemeMode.system,
        routerConfig: _router,
        debugShowCheckedModeBanner: false,
        // G-092: overlay the lock gate above the GoRouter shell so navigation
        // state survives. `child` is the router's current navigator.
        builder: (context, child) {
          if (_locked) {
            return LockScreen(
              onUnlock: () => setState(() => _locked = false),
            );
          }
          return child ?? const SizedBox.shrink();
        },
      ),
    );
  }
}
