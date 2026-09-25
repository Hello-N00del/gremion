// mobile/lib/services/auth_service.dart
import 'dart:convert';
import 'dart:developer' as developer;
import 'package:flutter/foundation.dart';
import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:jose/jose.dart';
import 'package:http/http.dart' as http;
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/user_session.dart';

// Build-time constants — injected via --dart-define
const _gatewayUrl = String.fromEnvironment(
  'GATEWAY_URL',
  defaultValue: 'http://localhost:3001',
);
const _issuerUrl = String.fromEnvironment(
  'KEYCLOAK_ISSUER',
  defaultValue: 'http://localhost:8082/auth/realms/sturaos',
);
const _clientId = String.fromEnvironment(
  'KEYCLOAK_CLIENT_ID',
  defaultValue: 'stura-mobile',
);
// AppAuth redirect URI — injected via --dart-define=AUTH_CALLBACK_URL.
//
// G-051 SECURITY NOTE:
// The default `stura://auth/callback` is a custom URI scheme. Custom schemes
// are inherently spoofable — any other Android app declaring the same scheme
// in an <intent-filter> can register as a handler. Mitigations in this
// codebase:
//   1. PKCE is enabled by default by flutter_appauth (do NOT add
//      `useNonce: false` or `responseMode` overrides that would weaken it —
//      checked against this file: no such overrides present).
//   2. The `state` parameter is auto-generated per `authorize()` call by
//      flutter_appauth v7+ and validated on callback, dropping unsolicited
//      calls from any rogue app that grabbed the scheme.
//   3. Wave 1 G-002 fail-fasts release builds without a real Android
//      keystore (see `android/app/build.gradle.kts`), so any malicious APK
//      trying to claim the scheme cannot impersonate the release-signed
//      build's package id — narrows the blast radius to debug builds and
//      sideloaded prod APKs.
//
// flutter_appauth has open bugs with HTTPS redirect URIs that block
// migration to App Links (Android) / Universal Links (iOS):
//   Android issue #505/#546: app not brought to foreground after auth completes
//   iOS issue #566: authorize() never returns with a Universal Link redirect URI
//
// Migration plan: see docs/specs/mobile-oidc-scheme-migration.md. Re-open
// G-051 as a follow-up gap the day flutter_appauth ships fixes upstream.
const _redirectUrl = String.fromEnvironment(
  'AUTH_CALLBACK_URL',
  defaultValue: 'stura://auth/callback',
);

// Optional: bypass OIDC discovery with explicit endpoints.
// Required on Android emulator: Keycloak's discovery response returns
// localhost:8082 as the base URL, which is unreachable from the emulator.
// Set to the realm base URL reachable from the device, e.g.:
//   --dart-define=KEYCLOAK_ENDPOINT_BASE=http://10.0.2.2:8082/auth/realms/sturaos
const _endpointBase = String.fromEnvironment(
  'KEYCLOAK_ENDPOINT_BASE',
  defaultValue: '',
);

// G-052: Matrix homeserver URL is derived ONLY from this build-time constant.
// A compromised Keycloak client (or a maliciously-crafted JWT that happens to
// verify against our JWKS) could otherwise put any URL into a `homeserver_url`
// claim and steer the embedded Matrix client at an attacker-controlled HS.
// The build-time constant is also re-checked at boot by main.dart's
// assertReleaseHttps() so a cleartext default cannot ship in release.
const _homeserverUrl = String.fromEnvironment(
  'HOMESERVER_URL',
  defaultValue: 'http://localhost:8009',
);

/// Clock-skew tolerance applied when validating the JWT `nbf` claim (G-088).
/// 30 seconds matches the default leeway used by mainstream OIDC libraries
/// (e.g. pyjwt's `leeway`, node-jsonwebtoken's `clockTolerance`).
const Duration kJwtNbfClockSkew = Duration(seconds: 30);

/// G-088: validates a JWT's `nbf` ("not before") claim per RFC 7519 §4.1.5.
///
/// If `nbf` is absent, this is a no-op (matches RFC: the claim is optional).
/// If `nbf` is present and lies more than [kJwtNbfClockSkew] in the future
/// relative to [now], throws an [Exception] — accepting an early token would
/// let an attacker pre-mint credentials for activation at a controlled time
/// or hide a replay window behind device clock drift.
///
/// Pulled out as a top-level function so the test suite can drive it directly
/// without having to forge a JWKS-verifiable JWT (mirrors the
/// `@visibleForTesting` pattern used elsewhere in this file).
void validateNbf(Map<String, dynamic> payload, DateTime now) {
  final nbf = payload['nbf'];
  final nbfSec = nbf is int ? nbf : (nbf is num ? nbf.toInt() : null);
  if (nbfSec == null) return;
  final nbfTime = DateTime.fromMillisecondsSinceEpoch(nbfSec * 1000);
  final nowWithSkew = now.add(kJwtNbfClockSkew);
  if (nbfTime.isAfter(nowWithSkew)) {
    throw Exception('JWT not yet valid (nbf=$nbfTime, now+skew=$nowWithSkew)');
  }
}

// Always returns explicit endpoints — never relies on OIDC discovery.
// Keycloak's discovery response advertises localhost:8082 as the base URL,
// which is unreachable from the Android emulator. By deriving all endpoints
// explicitly from _issuerUrl (already set to the device-reachable address,
// e.g. http://10.0.2.2:8082/...), we bypass discovery entirely.
// _endpointBase overrides _issuerUrl when a different internal base is needed.
AuthorizationServiceConfiguration _buildServiceConfig() {
  final base = _endpointBase.isNotEmpty ? _endpointBase : _issuerUrl;
  return AuthorizationServiceConfiguration(
    authorizationEndpoint: '$base/protocol/openid-connect/auth',
    tokenEndpoint: '$base/protocol/openid-connect/token',
    endSessionEndpoint: '$base/protocol/openid-connect/logout',
  );
}

class AuthService extends ChangeNotifier {
  AuthService({
    FlutterSecureStorage? storage,
    FlutterAppAuth? appAuth,
    LocalAuthentication? localAuth,
    http.Client? httpClient,
  })  : _storage = storage ??
            const FlutterSecureStorage(
              iOptions: IOSOptions(
                  accessibility:
                      KeychainAccessibility.first_unlock_this_device),
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            ),
        _appAuth = appAuth ?? const FlutterAppAuth(),
        _localAuth = localAuth ?? LocalAuthentication(),
        _httpClient = httpClient ?? http.Client();

  /// Testability seam — inject a mock FlutterSecureStorage.
  AuthService.withStorage(FlutterSecureStorage storage)
      : this(storage: storage);

  final FlutterSecureStorage _storage;
  final FlutterAppAuth _appAuth;
  final LocalAuthentication _localAuth;
  final http.Client _httpClient;

  UserSession? _session;

  bool get isAuthenticated => _session != null;
  UserSession? get session => _session;

  /// Restore session from SecureStorage on app start.
  ///
  /// G-052: Matrix homeserver URL is sourced exclusively from the build-time
  /// [_homeserverUrl] constant — never from secure storage. An attacker who
  /// briefly gained write access to secure storage (or a stale value from a
  /// previous build with a different HS URL) MUST NOT be able to pivot the
  /// embedded Matrix session here.
  Future<bool> restoreSession() async {
    final at = await _storage.read(key: 'access_token');
    final rt = await _storage.read(key: 'refresh_token');
    final idt = await _storage.read(key: 'id_token');
    final role = await _storage.read(key: 'role');
    final userId = await _storage.read(key: 'matrix_user_id');
    final matrixDeviceId = await _storage.read(key: 'matrix_device_id');
    final matrixToken = await _storage.read(key: 'matrix_token');

    if (at == null || rt == null || idt == null) {
      return false;
    }
    _session = UserSession.fromJson({
      'access_token': at,
      'refresh_token': rt,
      'id_token': idt,
      'role': role,
      'matrix_user_id': userId ?? '',
      'matrix_device_id': matrixDeviceId ?? '',
      'matrix_token': matrixToken ?? '',
      'homeserver_url': _homeserverUrl,
    });
    notifyListeners();
    return true;
  }

  /// Opens system browser → Keycloak login → deep link back.
  ///
  /// allowInsecureConnections enables flutter_appauth's InsecureConnectionBuilder
  /// (allows HTTP) and AppAuthConfiguration.setSkipIssuerHttpsCheck(true) which
  /// bypasses the HTTPS requirement on the `iss` claim — needed for dev Keycloak
  /// running on plain HTTP. JWT signature is still verified in _persistTokens.
  Future<void> login() async {
    final result = await _appAuth.authorizeAndExchangeCode(
      AuthorizationTokenRequest(
        _clientId,
        _redirectUrl,
        serviceConfiguration: _buildServiceConfig(),
        scopes: ['openid', 'profile', 'email', 'offline_access', 'roles'],
        allowInsecureConnections: kDebugMode,
        // G-093: PKCE uses the S256 code-challenge method. flutter_appauth
        // generates the PKCE challenge itself and defaults to S256; on v7+
        // (AppAuth-Android/iOS) passing `code_challenge_method` as an
        // additionalParameter is REJECTED at runtime
        // ("...directly supported via the authorization request builder...")
        // — so we rely on the library default rather than re-declaring it.
        // (flutter_appauth has shipped S256 by default since v0.9; a future
        // drift to `plain` would be a library regression, not a config gap.)
      ),
    );
    // #261: guard refreshToken alongside the other two — it is nullable on
    // AuthorizationTokenResponse, and the next line asserts it non-null. If
    // Keycloak stops returning one (offline_access dropped, client policy
    // change) we want this diagnostic rather than an opaque null-check crash.
    if (result.accessToken == null ||
        result.idToken == null ||
        result.refreshToken == null) {
      throw Exception(
          'Incomplete token response: accessToken, idToken or refreshToken missing');
    }
    await _persistTokens(
        result.accessToken!, result.refreshToken!, result.idToken!);
  }

  /// Silent refresh using stored refresh token.
  Future<void> refresh() async {
    final rt = await _storage.read(key: 'refresh_token');
    if (rt == null) throw Exception('No refresh token stored');
    final result = await _appAuth.token(
      TokenRequest(
        _clientId,
        _redirectUrl,
        serviceConfiguration: _buildServiceConfig(),
        refreshToken: rt,
        allowInsecureConnections: kDebugMode,
      ),
    );
    if (result.accessToken == null || result.idToken == null) {
      throw Exception(
          'Incomplete token refresh response: accessToken or idToken missing');
    }
    await _persistTokens(
        result.accessToken!, result.refreshToken ?? rt, result.idToken!);
  }

  Future<void> logout() async {
    final idt = await _storage.read(key: 'id_token');
    try {
      await _appAuth.endSession(
        EndSessionRequest(
          idTokenHint: idt,
          serviceConfiguration: _buildServiceConfig(),
          postLogoutRedirectUrl: _redirectUrl,
        ),
      );
    } on Exception catch (e, st) {
      // Keycloak endSession may fail when offline — local cleanup still proceeds.
      // Log so failed server-side session termination is observable.
      // G-091: routed via dart:developer.log so the diagnostic survives in
      // debug builds and is auto-filtered out in release builds (the prior
      // debug-print call would otherwise reach release stdout/logcat).
      developer.log('endSession failed (non-fatal)',
          name: 'AuthService', error: e, stackTrace: st);
    }
    await _storage.deleteAll();
    // G-045: evict JWKS cache on logout so a subsequent login fetches a
    // fresh key set (defends against device-time-skew + key-rotation overlap).
    _keyStore = null;
    _keyStoreFetchedAt = null;
    _session = null;
    notifyListeners();
  }

  /// Returns true if biometric unlock is enabled and succeeds.
  Future<bool> unlockWithBiometrics() async {
    final prefs = await SharedPreferences.getInstance();
    if (!(prefs.getBool('biometric_unlock') ?? false)) return false;
    final canCheck = await _localAuth.canCheckBiometrics;
    if (!canCheck) return false;
    return _localAuth.authenticate(
      localizedReason: 'Unlock StuRaOS',
      options: const AuthenticationOptions(biometricOnly: true),
    );
  }

  /// JWKS key store — refreshed at most once per [_jwksCacheTtl] window,
  /// evicted on logout and on any verify failure (with retry-once before
  /// final rejection to handle mid-rotation). Instance-level (not static)
  /// so logout() actually clears it across the lifetime of this AuthService.
  ///
  /// G-045: prevents a Keycloak signing-key rotation from locking the device
  /// out for the lifetime of the process.
  JsonWebKeyStore? _keyStore;
  DateTime? _keyStoreFetchedAt;

  static const Duration _jwksCacheTtl = Duration(hours: 24);

  /// Test-only accessors so the test suite can observe TTL/eviction state
  /// without relying on private fields.
  @visibleForTesting
  bool get debugJwksCachePopulated => _keyStore != null;
  @visibleForTesting
  DateTime? get debugJwksFetchedAt => _keyStoreFetchedAt;

  /// Test-only entry into [_getKeyStore]. Allows the test suite to drive
  /// cache freshness checks without exercising the full [_persistTokens]
  /// path (which depends on real JWT material).
  @visibleForTesting
  Future<void> refreshJwksForTest({bool forceRefresh = false}) async {
    await _getKeyStore(forceRefresh: forceRefresh);
  }

  /// Test-only seam to artificially age the cache (simulate TTL expiry).
  @visibleForTesting
  void debugAgeJwksCache(Duration by) {
    if (_keyStoreFetchedAt != null) {
      _keyStoreFetchedAt = _keyStoreFetchedAt!.subtract(by);
    }
  }

  Future<JsonWebKeyStore> _getKeyStore({bool forceRefresh = false}) async {
    final now = DateTime.now();
    final fresh = _keyStore != null &&
        _keyStoreFetchedAt != null &&
        now.difference(_keyStoreFetchedAt!) < _jwksCacheTtl;
    if (!forceRefresh && fresh) return _keyStore!;

    final base = _endpointBase.isNotEmpty ? _endpointBase : _issuerUrl;
    final uri = Uri.parse('$base/protocol/openid-connect/certs');
    if (kReleaseMode && uri.scheme != 'https') {
      throw StateError(
          'JWKS endpoint must be HTTPS in release builds (got ${uri.scheme})');
    }
    final response =
        await _httpClient.get(uri).timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) {
      throw Exception('Failed to fetch JWKS: ${response.statusCode}');
    }
    final jwks = JsonWebKeySet.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
    _keyStore = JsonWebKeyStore()..addKeySet(jwks);
    _keyStoreFetchedAt = now;
    return _keyStore!;
  }

  Future<void> _persistTokens(String at, String rt, String idt) async {
    // Verify JWT signature against Keycloak JWKS before trusting any claims.
    // G-045: on verify failure, evict the JWKS cache and retry exactly once
    // with a fresh fetch — handles the mid-rotation case where our cached
    // keys are stale but a fresh JWKS pull would still verify the token.
    final jwt = JsonWebToken.unverified(at);
    bool isValid = false;
    try {
      final store = await _getKeyStore();
      isValid = await jwt.verify(store);
    } catch (_) {
      isValid = false;
    }
    if (!isValid) {
      // Force one fresh JWKS pull in case Keycloak just rotated keys.
      _keyStore = null;
      _keyStoreFetchedAt = null;
      try {
        final freshStore = await _getKeyStore(forceRefresh: true);
        isValid = await jwt.verify(freshStore);
      } catch (_) {
        isValid = false;
      }
      if (!isValid) {
        _keyStore = null;
        _keyStoreFetchedAt = null;
        throw Exception('JWT signature verification failed after JWKS refresh');
      }
    }

    final payload = jwt.claims.toJson();

    // Signature alone is not enough — a token signed by ANY Keycloak realm
    // whose JWKS we happen to reach would otherwise verify. Enforce iss/aud
    // explicitly against the issuer this client was configured for.
    //
    // #261: anchor the expected issuer to KEYCLOAK_ISSUER ONLY — never the
    // KEYCLOAK_ENDPOINT_BASE transport override. The `iss` claim always
    // carries Keycloak's canonical issuer, so a divergent (or attacker-set)
    // endpoint base must not be able to relax this check by also moving the
    // expected value. The token is minted against _issuerUrl regardless of
    // which transport address fetched it.
    final expectedIssuer = _issuerUrl.replaceAll(RegExp(r'/$'), '');
    final tokenIssuer =
        (payload['iss'] as String?)?.replaceAll(RegExp(r'/$'), '');
    if (tokenIssuer == null || tokenIssuer != expectedIssuer) {
      throw Exception(
          'JWT issuer mismatch: expected $expectedIssuer, got ${tokenIssuer ?? '<missing>'}');
    }
    final rawAud = payload['aud'];
    final audiences = rawAud is List
        ? rawAud.map((a) => a.toString()).toList()
        : rawAud is String
            ? <String>[rawAud]
            : const <String>[];
    if (!audiences.contains(_clientId)) {
      throw Exception(
          'JWT audience does not include $_clientId (aud=${audiences.join(',')})');
    }
    final exp = payload['exp'];
    final expSec = exp is int ? exp : (exp is num ? exp.toInt() : null);
    if (expSec == null ||
        DateTime.fromMillisecondsSinceEpoch(expSec * 1000)
            .isBefore(DateTime.now())) {
      throw Exception('JWT expired or missing exp claim');
    }

    // G-088: enforce the `nbf` ("not before") claim alongside `exp` per
    // RFC 7519 §4.1.5. Pure helper so it's directly unit-testable without
    // having to forge a JWKS-verifiable token.
    validateNbf(payload, DateTime.now());

    final roles = (payload['realm_access']?['roles'] as List<dynamic>?) ?? [];
    final role = _highestRole(roles.map((r) => r.toString()).toList());

    // G-052: derive the Matrix homeserver URL exclusively from the build-time
    // constant. The JWT `homeserver_url` claim is intentionally ignored — a
    // compromised KC client could otherwise pivot the embedded Matrix session
    // to an attacker-controlled HS. If a claim is present, log a warning so
    // misconfiguration of the KC client/realm is observable in debug builds.
    final hsUrl = _homeserverUrl;
    final claimedHs = payload['homeserver_url'] as String?;
    if (claimedHs != null && claimedHs != hsUrl) {
      // G-091: routed via developer.log so the WARNING reaches the
      // structured-log infra in debug and is filtered out in release.
      developer.log(
        'WARNING: JWT homeserver_url claim ($claimedHs) ignored; using build-time HOMESERVER_URL ($hsUrl)',
        name: 'AuthService',
      );
    }

    // Exchange Keycloak JWT for a real Synapse access token via the gateway.
    // Pass the stored device_id so Synapse reuses the same device instead of
    // creating a new one — prevents OLM state churn on every token refresh.
    String matrixToken = '';
    String matrixUserId = '';
    String matrixDeviceId = '';
    try {
      final storedDeviceId = await _storage.read(key: 'matrix_device_id') ?? '';
      final tokenUri = storedDeviceId.isNotEmpty
          ? Uri.parse(
              '$_gatewayUrl/api/auth/matrix-token?device_id=${Uri.encodeComponent(storedDeviceId)}')
          : Uri.parse('$_gatewayUrl/api/auth/matrix-token');
      final resp = await _httpClient.get(
        tokenUri,
        headers: {'Authorization': 'Bearer $at'},
      ).timeout(const Duration(seconds: 10));
      if (resp.statusCode == 200) {
        final body = jsonDecode(resp.body) as Map<String, dynamic>;
        if (body['success'] == true) {
          matrixToken = (body['data']?['matrixToken'] as String?) ?? '';
          matrixUserId = (body['data']?['matrixUserId'] as String?) ?? '';
          matrixDeviceId = (body['data']?['matrixDeviceId'] as String?) ?? '';
        }
      }
      if (matrixToken.isEmpty) {
        // G-091: status code is not a secret — but never include the token
        // itself in this diagnostic (the gateway response body contains the
        // matrix token).
        developer.log(
          'Matrix token exchange returned empty token (status ${resp.statusCode}).',
          name: 'AuthService',
        );
      }
    } catch (e) {
      // G-091: log the exception type/message but not any token-shaped
      // substring. `e` here is typically a SocketException or HTTP timeout
      // — none of those carry secrets, but route via developer.log so the
      // diagnostic is auto-filtered in release builds.
      developer.log('Matrix token exchange failed (non-fatal)',
          name: 'AuthService', error: e);
    }

    await _storage.write(key: 'access_token', value: at);
    await _storage.write(key: 'refresh_token', value: rt);
    await _storage.write(key: 'id_token', value: idt);
    await _storage.write(key: 'role', value: role);
    await _storage.write(key: 'matrix_user_id', value: matrixUserId);
    await _storage.write(key: 'matrix_device_id', value: matrixDeviceId);
    await _storage.write(key: 'matrix_token', value: matrixToken);
    await _storage.write(key: 'homeserver_url', value: hsUrl);

    _session = UserSession.fromJson({
      'access_token': at,
      'refresh_token': rt,
      'id_token': idt,
      'role': role,
      'matrix_user_id': matrixUserId,
      'matrix_device_id': matrixDeviceId,
      'matrix_token': matrixToken,
      'homeserver_url': hsUrl,
    });
    notifyListeners();
  }

  String _highestRole(List<String> roles) {
    if (roles.contains('it-admin')) return 'it-admin';
    if (roles.contains('council-admin')) return 'council-admin';
    if (roles.contains('finance')) return 'finance';
    if (roles.contains('member')) return 'member';
    return 'guest';
  }
}
