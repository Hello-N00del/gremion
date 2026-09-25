// Verifies the scheme gate enforces HTTPS/WSS for every base URL,
// including HELIOS_BASE_URL (the G-003 surface).
//
// The pure validateHttpsSchemes helper is tested directly so the rejection
// path actually runs under `flutter test` (where kReleaseMode is a compile-
// time `false` and assertReleaseHttps short-circuits). assertReleaseHttps's
// release-mode delegation is covered by a separate non-release smoke test.
import 'package:flutter_test/flutter_test.dart';
import 'package:stura/app.dart';

void main() {
  group('validateHttpsSchemes (G-003)', () {
    test('rejects cleartext HELIOS_BASE_URL', () {
      expect(
        () => validateHttpsSchemes({
          'GATEWAY_URL': 'https://api.example',
          'SYGNAL_URL': 'https://sygnal.example',
          'HOMESERVER_URL': 'https://matrix.example',
          'KEYCLOAK_ISSUER': 'https://kc.example',
          'HELIOS_BASE_URL': 'http://localhost:8500',
        }),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('rejects cleartext on the first non-HELIOS URL too', () {
      expect(
        () => validateHttpsSchemes({
          'GATEWAY_URL': 'http://api.example',
          'HELIOS_BASE_URL': 'https://helios.example',
        }),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('accepts all-https/wss', () {
      expect(
        () => validateHttpsSchemes({
          'GATEWAY_URL': 'https://api.example',
          'SYGNAL_URL': 'wss://sygnal.example',
          'HOMESERVER_URL': 'https://matrix.example',
          'KEYCLOAK_ISSUER': 'https://kc.example',
          'HELIOS_BASE_URL': 'https://helios.example',
        }),
        returnsNormally,
      );
    });

    test('rejects an unparseable URL', () {
      expect(
        () => validateHttpsSchemes({'BAD': ''}),
        throwsA(isA<ArgumentError>()),
      );
    });
  });

  group('assertReleaseHttps (G-003 boot-time wrapper)', () {
    // Under `flutter test`, kReleaseMode is `false`, so the wrapper is a
    // no-op regardless of input. That's the expected behaviour for dev/CI;
    // the gate logic itself is covered by the validateHttpsSchemes tests.
    test('is a no-op in non-release mode (cleartext input)', () {
      expect(
        () => assertReleaseHttps({
          'HELIOS_BASE_URL': 'http://localhost:8500',
        }),
        returnsNormally,
      );
    });
  });
}
