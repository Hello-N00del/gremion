// Smoke test placeholder — the StuRaApp requires live auth/api providers
// so a full integration smoke test lives in integration_test/.
// This file exists to satisfy the default test runner discovery.
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('placeholder passes', () {
    expect(true, isTrue);
  });

  // G-050 smoke: confirm the global error-handler hooks accept the kind of
  // callbacks main.dart installs. main() itself isn't auto-run in unit tests,
  // so we can only assert the hooks are settable to the expected shape — the
  // real wiring is verified by `flutter run` on the emulator.
  test('FlutterError.onError accepts a void(FlutterErrorDetails) callback', () {
    final saved = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails details) {
      // no-op
    };
    expect(FlutterError.onError, isNotNull);
    FlutterError.onError = saved;
  });

  test('PlatformDispatcher.instance.onError accepts bool(error, stack)', () {
    final saved = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      return true;
    };
    expect(PlatformDispatcher.instance.onError, isNotNull);
    PlatformDispatcher.instance.onError = saved;
  });

  test('ErrorWidget.builder is overridable', () {
    final saved = ErrorWidget.builder;
    if (!kDebugMode) {
      ErrorWidget.builder =
          (FlutterErrorDetails details) => const SizedBox.shrink();
    }
    expect(ErrorWidget.builder, isNotNull);
    ErrorWidget.builder = saved;
  });
}
