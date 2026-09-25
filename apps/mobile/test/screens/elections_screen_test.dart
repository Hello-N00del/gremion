// mobile/test/screens/elections_screen_test.dart
//
// G-089 regression: `isHeliosNavigationAllowed` rejects any non-HTTPS URL
// (data:, javascript:, file:, about:) AND any URL whose host doesn't match
// the configured Helios base URL.
//
// Tests target the extracted pure predicate rather than the live
// `InAppWebView` widget — the widget itself requires platform channels that
// aren't available in the host-only `flutter test` runner.
import 'package:flutter_test/flutter_test.dart';
import 'package:stura/screens/elections/elections_screen.dart';

void main() {
  const allowedBase = 'https://helios.sturaos.example';

  group('isHeliosNavigationAllowed — G-089 scheme + host allowlist', () {
    test('null URL → CANCEL', () {
      expect(isHeliosNavigationAllowed(null, allowedBase), isFalse);
    });

    test('data: URL on matching host → CANCEL', () {
      // RFC 2397 data URIs have no host; they should be rejected purely on
      // scheme, before any host comparison runs.
      final url = Uri.parse('data:text/html,<script>alert(1)</script>');
      expect(isHeliosNavigationAllowed(url, allowedBase), isFalse,
          reason: 'data: must be rejected even with no host');
    });

    test('javascript: URL → CANCEL', () {
      final url = Uri.parse('javascript:alert(1)');
      expect(isHeliosNavigationAllowed(url, allowedBase), isFalse);
    });

    test('about:blank → CANCEL', () {
      final url = Uri.parse('about:blank');
      expect(isHeliosNavigationAllowed(url, allowedBase), isFalse);
    });

    test('file:// URL → CANCEL', () {
      final url = Uri.parse('file:///etc/passwd');
      expect(isHeliosNavigationAllowed(url, allowedBase), isFalse);
    });

    test('http:// (plain) on matching host → CANCEL', () {
      // Even if hosts match, demote-from-https is rejected to prevent
      // MITM downgrade on the in-app browser.
      final url = Uri.parse('http://helios.sturaos.example/elections/1/vote');
      expect(isHeliosNavigationAllowed(url, allowedBase), isFalse,
          reason: 'http→https downgrade must be rejected');
    });

    test('https:// matching host + path → ALLOW', () {
      final url =
          Uri.parse('https://helios.sturaos.example/elections/1/vote?cast=yes');
      expect(isHeliosNavigationAllowed(url, allowedBase), isTrue);
    });

    test('https:// different host → CANCEL', () {
      final url = Uri.parse('https://evil.example/elections/1/vote');
      expect(isHeliosNavigationAllowed(url, allowedBase), isFalse);
    });

    test('https:// subdomain that is NOT exactly the allowed host → CANCEL',
        () {
      // Strict host equality — a Host-header trick like
      // helios.sturaos.example.evil.com must not slip through.
      final url =
          Uri.parse('https://helios.sturaos.example.evil.com/elections/1/vote');
      expect(isHeliosNavigationAllowed(url, allowedBase), isFalse);
    });

    test('unparseable allowedBaseUrl → CANCEL (fail closed)', () {
      // Uri.tryParse may return non-null even for strange inputs, but the
      // host comparison still has to be safe. A literal garbage string with
      // no scheme/host parses to Uri(host: '') which won't match a real
      // host like 'helios.sturaos.example'.
      final url = Uri.parse('https://helios.sturaos.example/x');
      expect(isHeliosNavigationAllowed(url, '!!! not a url !!!'), isFalse);
    });
  });
}
