// mobile/test/services/matrix_service_test.dart
//
// Wave 3c T1.1 (G-047) — small smoke coverage for MatrixService lifecycle.
//
// The matrix package's Client/Room types are notoriously hard to mock
// (final classes with internal state machines). These tests deliberately
// stay narrow: they verify dispose() is idempotent and the never-logged-in
// path doesn't crash. Full reconnect-cancel-and-resubscribe behaviour is
// verified by manual hot-restart on the Android emulator (commit body).
import 'package:flutter_test/flutter_test.dart';
import 'package:stura/services/matrix_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('MatrixService lifecycle (G-047)', () {
    test('dispose() on a never-initialised service is a no-op', () {
      final svc = MatrixService(homeserverUrl: 'http://localhost:8009');
      // No init(), no loginWithToken() — _client is `late` and unassigned,
      // _syncSub is null. dispose() must not throw.
      expect(svc.isSyncing, isFalse);
      expect(() => svc.dispose(), returnsNormally);
    });

    test('isSyncing and isInitialized are false on a fresh MatrixService', () {
      final svc = MatrixService(homeserverUrl: 'http://localhost:8009');
      expect(svc.isSyncing, isFalse);
      expect(svc.isInitialized, isFalse);
      svc.dispose();
    });

    // #233: logout teardown must not throw when called on a service that was
    // never initialised (never logged in). deleteLocalDatabase() has no db
    // path yet and the secure-storage delete has no platform channel under
    // `flutter test`; both are guarded so the call completes normally.
    test('deleteLocalDatabase() on a fresh service is a no-op', () async {
      final svc = MatrixService(homeserverUrl: 'http://localhost:8009');
      await expectLater(svc.deleteLocalDatabase(), completes);
      expect(svc.isInitialized, isFalse);
      svc.dispose();
    });

    test('logout() on a never-initialised service does not throw', () async {
      final svc = MatrixService(homeserverUrl: 'http://localhost:8009');
      await expectLater(svc.logout(), completes);
      expect(svc.isSyncing, isFalse);
      svc.dispose();
    });
  });
}
