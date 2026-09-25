// mobile/test/services/crash_reporter_test.dart
//
// Wave 3c T5.1 (G-050) — smoke coverage for CrashReporter.
import 'package:flutter_test/flutter_test.dart';
import 'package:stura/services/crash_reporter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('CrashReporter (G-050)', () {
    test('init() is idempotent', () async {
      final reporter = CrashReporter.instance;
      await reporter.init();
      expect(reporter.isInitialized, isTrue);
      await reporter.init(); // second call must not throw
      expect(reporter.isInitialized, isTrue);
    });

    test('reportError does not throw with no remote sink configured', () async {
      final reporter = CrashReporter.instance;
      await reporter.init();
      expect(reporter.isRemoteAvailable, isFalse);

      expect(
        reporter.reportError(
          Exception('test error'),
          StackTrace.current,
          fatal: false,
          context: {'where': 'unit-test'},
        ),
        completes,
      );
    });

    test('fatal=true reportError completes normally', () async {
      final reporter = CrashReporter.instance;
      await reporter.init();
      expect(
        reporter.reportError(
          StateError('fatal test'),
          StackTrace.current,
          fatal: true,
        ),
        completes,
      );
    });
  });
}
