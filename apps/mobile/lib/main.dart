// mobile/lib/main.dart
// B1: hive_flutter removed — MatrixSdkDatabase uses sqflite, no app-level init needed
// B2: flutter_vodozemac replaces flutter_olm — must call vod.init() before creating Client(...)
import 'dart:async';
import 'dart:ui';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_vodozemac/flutter_vodozemac.dart' as vod;
import 'app.dart';
import 'services/crash_reporter.dart';

Future<void> main() async {
  // G-050: wrap everything inside runZonedGuarded so any async error that
  // escapes a Future without `.catchError` is captured. The binding MUST be
  // initialised inside the zone — reversing the order breaks error capture
  // for any error thrown during framework init.
  await runZonedGuarded<Future<void>>(() async {
    WidgetsFlutterBinding.ensureInitialized();

    // C18: boot-time HTTPS assertion — release builds must not use cleartext
    // endpoints. Misconfigured builds fail here instead of leaking tokens.
    // #261: KEYCLOAK_ENDPOINT_BASE overrides every OIDC endpoint (auth/token/
    // end-session/JWKS) when set, so it must clear this gate too — but only
    // when non-empty (empty = not overridden, nothing to check).
    final httpsEndpoints = <String, String>{
      'GATEWAY_URL': gatewayUrl,
      'SYGNAL_URL': sygnalUrl,
      'HOMESERVER_URL': homeserverUrl,
      'KEYCLOAK_ISSUER': issuerUrl,
      'HELIOS_BASE_URL': heliosBaseUrl,
    };
    if (endpointBase.isNotEmpty) {
      httpsEndpoints['KEYCLOAK_ENDPOINT_BASE'] = endpointBase;
    }
    assertReleaseHttps(httpsEndpoints);

    await vod.init(); // B2: must run before any matrix Client is created

    // Firebase (FCM push notifications) — optional for local dev.
    // Requires google-services.json; silently skipped if not configured.
    try {
      await Firebase.initializeApp();
    } catch (_) {}

    // G-050: crash reporter wired before installing the global error hooks
    // so any error fired during the rest of init() is captured.
    await CrashReporter.instance.init();

    // G-050: Flutter framework errors (build/layout/paint).
    FlutterError.onError = (FlutterErrorDetails details) {
      FlutterError.presentError(details);
      CrashReporter.instance.reportError(
        details.exception,
        details.stack ?? StackTrace.current,
        fatal: false,
        context: {'library': details.library ?? 'flutter'},
      );
    };

    // G-050: platform-level errors (uncaught engine-side). Returning `true`
    // suppresses the default print (CrashReporter already handles it).
    PlatformDispatcher.instance.onError = (error, stack) {
      CrashReporter.instance.reportError(error, stack, fatal: true);
      return true;
    };

    // G-050: friendlier release-mode ErrorWidget — never show the framework's
    // red error box to production users.
    if (!kDebugMode) {
      ErrorWidget.builder = (FlutterErrorDetails details) {
        // Forward the synchronous build error to the reporter as well; the
        // FlutterError.onError hook above may not have fired yet for build
        // errors that happen before frame submission.
        CrashReporter.instance.reportError(
          details.exception,
          details.stack ?? StackTrace.current,
          fatal: false,
          context: {'phase': 'ErrorWidget.builder'},
        );
        return Container(
          color: const Color(0xFFF8F8F8),
          alignment: Alignment.center,
          padding: const EdgeInsets.all(16),
          child: const Text(
            'Something went wrong. The team has been notified.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: Color(0xFF333333)),
          ),
        );
      };
    }

    runApp(const StuRaApp());
  }, (error, stack) {
    // G-050: catches any async error that escapes a Future without `.catchError`.
    CrashReporter.instance.reportError(error, stack, fatal: true);
  });
}
