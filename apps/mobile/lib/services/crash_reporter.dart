// mobile/lib/services/crash_reporter.dart
//
// G-050: single-instance crash reporter. Initialised lazily from main();
// in builds without Firebase Crashlytics (the current state of the project)
// it degrades to debug-stderr logging only. The Firebase Crashlytics opt-in
// is left as a one-line follow-up — see [_maybeImportCrashlytics] below.
import 'dart:developer' as developer;
import 'package:flutter/foundation.dart';

class CrashReporter {
  CrashReporter._();
  static final CrashReporter instance = CrashReporter._();

  bool _initialized = false;
  bool _remoteAvailable = false;

  /// True if [init] has been called.
  bool get isInitialized => _initialized;

  /// True if a remote sink (Crashlytics, Sentry, etc.) is wired and accepting
  /// reports. Always false until the opt-in lands.
  bool get isRemoteAvailable => _remoteAvailable;

  Future<void> init() async {
    if (_initialized) return;
    _initialized = true;
    try {
      final dynamic remote = await _maybeImportCrashlytics();
      _remoteAvailable = remote != null;
    } catch (_) {
      // Remote sink unavailable — that's fine; reporter logs locally only.
      _remoteAvailable = false;
    }
  }

  /// Stub: returns `null` until firebase_crashlytics is added to pubspec.
  /// One-line opt-in for the future contributor:
  ///   `return FirebaseCrashlytics.instance;` after adding the import.
  Future<dynamic> _maybeImportCrashlytics() async => null;

  /// Report an error + stack. In debug builds writes to the structured
  /// developer log so the developer sees the crash; in release builds and
  /// when remote is wired, forwards to the remote sink.
  ///
  /// G-091: switched from the previous debug-print call to
  /// dart:developer.log so the diagnostic is auto-filtered out in release
  /// builds by the Flutter framework rather than reaching device
  /// stdout/logcat.
  Future<void> reportError(
    Object error,
    StackTrace stack, {
    bool fatal = false,
    Map<String, Object?> context = const {},
  }) async {
    if (kDebugMode) {
      developer.log(
        fatal ? 'FATAL' : 'error',
        name: 'CrashReporter',
        error: error,
        stackTrace: stack,
      );
      if (context.isNotEmpty) {
        developer.log('context: $context', name: 'CrashReporter');
      }
    }
    if (_remoteAvailable) {
      // Future: forward to Crashlytics / Sentry here.
      // await FirebaseCrashlytics.instance.recordError(error, stack, fatal: fatal);
    }
  }
}
