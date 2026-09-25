// mobile/test/services/auth_service_test.dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';
import 'package:stura/services/auth_service.dart';
import 'package:stura/models/user_session.dart';

class MockSecureStorage extends Mock implements FlutterSecureStorage {}

/// Minimal valid JWKS payload — we don't actually verify any tokens against
/// it; we only need the JSON to parse cleanly so [_getKeyStore] populates the
/// cache and we can observe TTL behaviour.
const _validJwksJson = '''
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "test-key-1",
      "use": "sig",
      "alg": "RS256",
      "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      "e": "AQAB"
    }
  ]
}
''';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AuthService sut;
  late MockSecureStorage storage;

  setUp(() {
    storage = MockSecureStorage();
    sut = AuthService.withStorage(storage);
  });

  test('restoreSession returns false when no stored tokens', () async {
    when(() => storage.read(key: any(named: 'key')))
        .thenAnswer((_) async => null);
    final result = await sut.restoreSession();
    expect(result, false);
    expect(sut.isAuthenticated, false);
  });

  test('restoreSession returns true when tokens present', () async {
    when(() => storage.read(key: 'access_token')).thenAnswer((_) async => 'at');
    when(() => storage.read(key: 'refresh_token'))
        .thenAnswer((_) async => 'rt');
    when(() => storage.read(key: 'id_token')).thenAnswer((_) async => 'idt');
    when(() => storage.read(key: 'role')).thenAnswer((_) async => 'member');
    when(() => storage.read(key: 'matrix_user_id'))
        .thenAnswer((_) async => '@u:h');
    when(() => storage.read(key: 'matrix_device_id'))
        .thenAnswer((_) async => 'DEV1');
    when(() => storage.read(key: 'matrix_token')).thenAnswer((_) async => 'mt');
    when(() => storage.read(key: 'homeserver_url'))
        .thenAnswer((_) async => 'http://h');
    final result = await sut.restoreSession();
    expect(result, true);
    expect(sut.session!.role, StuRaRole.member);
  });

  test('logout clears all storage keys', () async {
    when(() => storage.read(key: 'id_token')).thenAnswer((_) async => 'idt');
    when(() => storage.deleteAll()).thenAnswer((_) async {});
    await sut.logout();
    verify(() => storage.deleteAll()).called(1);
    expect(sut.isAuthenticated, false);
  });

  // ----------------------------------------------------------------------
  // G-052 — homeserver_url derives ONLY from build-time constant
  // ----------------------------------------------------------------------
  group('homeserver URL hard-pin (G-052)', () {
    test('restoreSession ignores any stored homeserver_url value', () async {
      when(() => storage.read(key: 'access_token'))
          .thenAnswer((_) async => 'at');
      when(() => storage.read(key: 'refresh_token'))
          .thenAnswer((_) async => 'rt');
      when(() => storage.read(key: 'id_token')).thenAnswer((_) async => 'idt');
      when(() => storage.read(key: 'role')).thenAnswer((_) async => 'member');
      when(() => storage.read(key: 'matrix_user_id'))
          .thenAnswer((_) async => '@u:h');
      when(() => storage.read(key: 'matrix_device_id'))
          .thenAnswer((_) async => 'DEV1');
      when(() => storage.read(key: 'matrix_token'))
          .thenAnswer((_) async => 'mt');
      // Adversarial stored value — must NOT win.
      when(() => storage.read(key: 'homeserver_url'))
          .thenAnswer((_) async => 'https://evil.example/');

      final ok = await sut.restoreSession();
      expect(ok, isTrue);
      // Build-time default in tests is 'http://localhost:8009' (the
      // String.fromEnvironment default since no --dart-define is set).
      expect(sut.session!.homeserverUrl, equals('http://localhost:8009'),
          reason: 'restoreSession MUST ignore stored homeserver_url');
      expect(sut.session!.homeserverUrl, isNot(contains('evil')));
    });

    test('restoreSession does NOT require homeserver_url in storage', () async {
      // Critical compatibility scenario: an older app version may have
      // never written homeserver_url to storage at all. After G-052 we
      // rely entirely on the build-time constant — restoreSession must
      // still succeed.
      when(() => storage.read(key: 'access_token'))
          .thenAnswer((_) async => 'at');
      when(() => storage.read(key: 'refresh_token'))
          .thenAnswer((_) async => 'rt');
      when(() => storage.read(key: 'id_token')).thenAnswer((_) async => 'idt');
      when(() => storage.read(key: 'role')).thenAnswer((_) async => 'member');
      when(() => storage.read(key: 'matrix_user_id'))
          .thenAnswer((_) async => '@u:h');
      when(() => storage.read(key: 'matrix_device_id'))
          .thenAnswer((_) async => null);
      when(() => storage.read(key: 'matrix_token'))
          .thenAnswer((_) async => null);
      when(() => storage.read(key: 'homeserver_url'))
          .thenAnswer((_) async => null);

      final ok = await sut.restoreSession();
      expect(ok, isTrue);
      expect(sut.session!.homeserverUrl, equals('http://localhost:8009'));
    });
  });

  // ----------------------------------------------------------------------
  // G-045 — JWKS cache TTL + retry-once + logout eviction
  // ----------------------------------------------------------------------
  group('JWKS cache (G-045)', () {
    /// Returns a MockClient that records each JWKS request and serves
    /// [_validJwksJson] on /openid-connect/certs.
    (MockClient, List<Uri>) jwksRecorder() {
      final hits = <Uri>[];
      final client = MockClient((req) async {
        if (req.url.path.endsWith('/protocol/openid-connect/certs')) {
          hits.add(req.url);
          return http.Response(_validJwksJson, 200,
              headers: {'content-type': 'application/json'});
        }
        return http.Response('not found', 404);
      });
      return (client, hits);
    }

    test('first call populates cache; second call within TTL is cached',
        () async {
      final (client, hits) = jwksRecorder();
      final s = AuthService(storage: storage, httpClient: client);
      expect(s.debugJwksCachePopulated, isFalse);

      await s.refreshJwksForTest();
      expect(s.debugJwksCachePopulated, isTrue);
      expect(hits.length, 1);

      await s.refreshJwksForTest();
      expect(hits.length, 1,
          reason: 'within-TTL call must be served from cache');
    });

    test('expired cache refetches on next call', () async {
      final (client, hits) = jwksRecorder();
      final s = AuthService(storage: storage, httpClient: client);

      await s.refreshJwksForTest();
      expect(hits.length, 1);

      // Age the cache past the 24h TTL.
      s.debugAgeJwksCache(const Duration(hours: 24, minutes: 1));

      await s.refreshJwksForTest();
      expect(hits.length, 2, reason: 'post-TTL call must refetch');
    });

    test('forceRefresh bypasses the cache', () async {
      final (client, hits) = jwksRecorder();
      final s = AuthService(storage: storage, httpClient: client);

      await s.refreshJwksForTest();
      expect(hits.length, 1);

      await s.refreshJwksForTest(forceRefresh: true);
      expect(hits.length, 2);
    });

    test('logout evicts the JWKS cache', () async {
      final (client, hits) = jwksRecorder();
      final s = AuthService(storage: storage, httpClient: client);

      // Match the existing logout test: stubbing id_token to a value
      // lets endSession reach its plugin call (which fails with a non-fatal
      // MissingPluginException in unit tests — caught by AuthService.logout).
      when(() => storage.read(key: 'id_token')).thenAnswer((_) async => 'idt');
      when(() => storage.deleteAll()).thenAnswer((_) async {});

      await s.refreshJwksForTest();
      expect(s.debugJwksCachePopulated, isTrue);
      expect(s.debugJwksFetchedAt, isNotNull);

      await s.logout();
      expect(s.debugJwksCachePopulated, isFalse,
          reason: 'logout must evict the JWKS cache');
      expect(s.debugJwksFetchedAt, isNull);
    });

    test('non-200 JWKS response throws and does not populate cache', () async {
      final client = MockClient((req) async => http.Response('boom', 503));
      final s = AuthService(storage: storage, httpClient: client);

      await expectLater(s.refreshJwksForTest(), throwsException);
      expect(s.debugJwksCachePopulated, isFalse);
    });
  });

  // ----------------------------------------------------------------------
  // G-088 — JWT `nbf` validation with 30s clock-skew tolerance (RFC 7519)
  // ----------------------------------------------------------------------
  group('JWT nbf validation (G-088)', () {
    // Helper: build an `nbf` claim N seconds from the reference `now`.
    int nbfSecondsFromNow(DateTime now, Duration offset) =>
        now.add(offset).millisecondsSinceEpoch ~/ 1000;

    test('payload with no nbf claim passes', () {
      final now = DateTime.utc(2026, 5, 27, 12, 0, 0);
      expect(() => validateNbf(<String, dynamic>{}, now), returnsNormally);
    });

    test('nbf in the past passes (token already valid)', () {
      final now = DateTime.utc(2026, 5, 27, 12, 0, 0);
      final payload = <String, dynamic>{
        'nbf': nbfSecondsFromNow(now, const Duration(seconds: -60)),
      };
      expect(() => validateNbf(payload, now), returnsNormally);
    });

    test('nbf 10 seconds in the future is accepted (within 30s skew)', () {
      final now = DateTime.utc(2026, 5, 27, 12, 0, 0);
      final payload = <String, dynamic>{
        'nbf': nbfSecondsFromNow(now, const Duration(seconds: 10)),
      };
      expect(() => validateNbf(payload, now), returnsNormally,
          reason: '10s < 30s clock-skew window — must accept');
    });

    test('nbf 2 minutes in the future is rejected (beyond skew window)', () {
      final now = DateTime.utc(2026, 5, 27, 12, 0, 0);
      final payload = <String, dynamic>{
        'nbf': nbfSecondsFromNow(now, const Duration(minutes: 2)),
      };
      expect(
        () => validateNbf(payload, now),
        throwsA(isA<Exception>().having(
          (e) => e.toString(),
          'message',
          contains('not yet valid'),
        )),
        reason: '120s > 30s clock-skew window — must reject',
      );
    });

    test('nbf as num (e.g. parsed from JSON double) is coerced to int', () {
      final now = DateTime.utc(2026, 5, 27, 12, 0, 0);
      final payload = <String, dynamic>{
        'nbf': nbfSecondsFromNow(now, const Duration(seconds: 10)).toDouble(),
      };
      expect(() => validateNbf(payload, now), returnsNormally);
    });

    test('non-numeric nbf (malformed) is silently ignored (no false positive)',
        () {
      // RFC 7519 §4.1.5 says nbf MUST be a NumericDate. If the JWT signer
      // ships something else, we treat it as "no nbf" — the JWKS-signature
      // check upstream is the proper defence against malformed claims.
      final now = DateTime.utc(2026, 5, 27, 12, 0, 0);
      final payload = <String, dynamic>{'nbf': 'tomorrow'};
      expect(() => validateNbf(payload, now), returnsNormally);
    });

    test('clock-skew constant is exactly 30 seconds (RFC-aligned default)', () {
      expect(kJwtNbfClockSkew, equals(const Duration(seconds: 30)));
    });
  });
}
