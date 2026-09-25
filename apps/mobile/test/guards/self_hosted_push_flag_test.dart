// TASK-166 / TRD-293: with FCM gone, the self-hosted push transport
// (UnifiedPush + Sygnal pusher) is kept but OFF by default.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
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

  group('logout deregistration', deregistrationTests);
}

// Review fix: logout must delete the UnifiedPush pusher by its real pushkey
// (the endpoint URL), even in a build with the flag off, and not rely on the
// UnifiedPush onUnregistered callback (installed only when the flag is on
// and fired only after the Matrix token is revoked).
void deregistrationTests() {
  const endpoint = 'https://up.invalid/endpoint/abc';

  PushService configured(http.Client client) =>
      PushService(sygnalUrl: 'https://push.invalid', httpClient: client)
        ..configure(
          homeserverUrl: 'https://matrix.invalid',
          matrixAccessToken: 'token',
          matrixUserId: '@user:matrix.invalid',
        );

  test('deregisterAll deletes the stored UnifiedPush pusher by its endpoint',
      () async {
    SharedPreferences.setMockInitialValues(
        {PushService.unifiedPushEndpointKey: endpoint});
    final requests = <http.Request>[];
    final push = configured(MockClient((request) async {
      requests.add(request);
      return http.Response('{}', 200);
    }));

    await push.deregisterAll();

    expect(requests, hasLength(1));
    expect(requests.single.method, 'PUT');
    expect(requests.single.url.toString(),
        'https://matrix.invalid/_matrix/client/v3/pushers/set');
    expect(requests.single.headers['Authorization'], 'Bearer token');
    expect(jsonDecode(requests.single.body), {
      'kind': null,
      'app_id': PushService.unifiedPushAppId,
      'pushkey': endpoint,
    });
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(PushService.unifiedPushEndpointKey), isNull);
  });

  test('a rejected deletion keeps the endpoint for the next attempt',
      () async {
    SharedPreferences.setMockInitialValues(
        {PushService.unifiedPushEndpointKey: endpoint});
    final push = configured(
        MockClient((_) async => http.Response('{"errcode":"M_UNKNOWN"}', 500)));

    await push.deregisterAll();

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(PushService.unifiedPushEndpointKey), endpoint);
  });

  test('nothing registered: no request', () async {
    SharedPreferences.setMockInitialValues({});
    var calls = 0;
    final push = configured(MockClient((_) async {
      calls++;
      return http.Response('{}', 200);
    }));

    await push.deregisterAll();

    expect(calls, 0);
  });
}
