// TASK-166 / TRD-293: with FCM gone, the self-hosted push transport
// (UnifiedPush + Sygnal pusher) is kept but OFF by default.
import 'package:flutter_test/flutter_test.dart';
import 'package:stura/services/push_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('self-hosted push is off unless the build opts in', () {
    expect(selfHostedPushEnabled, isFalse);
    expect(PushService(sygnalUrl: 'https://push.invalid').enabled, isFalse);
  });

  test('init() with the flag off registers nothing and touches no plugin',
      () async {
    // No platform channel exists under `flutter test`: any plugin call
    // (local notifications, UnifiedPush) would throw MissingPluginException.
    final push = PushService(sygnalUrl: 'https://push.invalid')
      ..configure(
        homeserverUrl: 'https://matrix.invalid',
        matrixAccessToken: 'token',
        matrixUserId: '@user:matrix.invalid',
      );
    await expectLater(push.init(), completes);
  });
}
