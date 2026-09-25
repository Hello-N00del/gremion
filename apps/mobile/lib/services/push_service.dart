import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:unifiedpush/unifiedpush.dart';

/// TASK-166 (TRD-293): the self-hosted push transport (UnifiedPush + a Sygnal
/// pusher registered through the Matrix CS API) stays in the app but is OFF
/// unless a build opts in with `--dart-define=ENABLE_SELF_HOSTED_PUSH=true`.
/// There is no store-vendor transport (FCM was removed in TASK-166), so with
/// the default build no push transport is active at all.
const selfHostedPushEnabled = bool.fromEnvironment(
  'ENABLE_SELF_HOSTED_PUSH',
  defaultValue: false,
);

/// Handles push notification registration (UnifiedPush, behind
/// [selfHostedPushEnabled]) and registers the push endpoint with Sygnal via
/// the Matrix CS API pusher endpoint.
class PushService {
  PushService({required this.sygnalUrl, this.enabled = selfHostedPushEnabled});

  final String sygnalUrl;

  /// Whether [init] registers the self-hosted transport. Defaults to the
  /// [selfHostedPushEnabled] build flag.
  final bool enabled;

  final _localNotifications = FlutterLocalNotificationsPlugin();
  static const _androidChannel = AndroidNotificationChannel(
    'stura_default',
    'StuRaOS',
    description: 'New message notifications',
    importance: Importance.high,
  );

  String? _homeserverUrl;
  String? _matrixAccessToken;

  /// Must be called with auth credentials before [init].
  void configure({
    required String homeserverUrl,
    required String matrixAccessToken,
    required String matrixUserId,
  }) {
    _homeserverUrl = homeserverUrl;
    _matrixAccessToken = matrixAccessToken;
  }

  Future<void> init() async {
    if (!enabled) {
      developer.log(
        'Self-hosted push is off (ENABLE_SELF_HOSTED_PUSH not set); '
        'no push transport registered.',
        name: 'PushService',
      );
      return;
    }
    await _initLocalNotifications();
    // UnifiedPush is Android-only; iOS has no transport until TASK-176.
    if (Platform.isAndroid) await _initUnifiedPush();
  }

  Future<void> _initLocalNotifications() async {
    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    const iosInit = DarwinInitializationSettings(
      requestAlertPermission: false, // request separately
      requestBadgePermission: false,
      requestSoundPermission: false,
    );
    await _localNotifications.initialize(
      const InitializationSettings(android: androidInit, iOS: iosInit),
    );

    // Create Android notification channel
    final androidPlugin =
        _localNotifications.resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();
    await androidPlugin?.createNotificationChannel(_androidChannel);
    // The removed FCM arm used to request the notification permission; the
    // local notifications shown for UnifiedPush need it too (POST_NOTIFICATIONS
    // on Android 13+).
    await androidPlugin?.requestNotificationsPermission();
  }

  Future<void> _initUnifiedPush() async {
    await UnifiedPush.initialize(
      onNewEndpoint: (endpoint, _) async {
        await _registerWithSygnal(
          pushkey: endpoint.url,
          appId: 'com.stura.app.up',
          kind: 'http',
        );
      },
      onRegistrationFailed: (_, __) {
        // G-091: developer.log auto-filtered in release.
        developer.log('UnifiedPush registration failed', name: 'PushService');
      },
      onUnregistered: (_) async {
        await _deregisterFromSygnal(appId: 'com.stura.app.up');
      },
      onMessage: (_, __) {
        // UnifiedPush delivers the push payload — show summary notification
        _showLocalNotification();
      },
    );
    await UnifiedPush.register();
  }

  Future<String> _resolveDeviceName() async {
    final deviceInfo = DeviceInfoPlugin();
    try {
      if (Platform.isIOS) {
        final iosInfo = await deviceInfo.iosInfo;
        return iosInfo.name; // e.g. "John's iPhone 15 Pro"
      } else {
        final androidInfo = await deviceInfo.androidInfo;
        return '${androidInfo.manufacturer} ${androidInfo.model}';
      }
    } catch (_) {
      // Fall back to a generic name if device info is unavailable.
      return Platform.isIOS ? 'iPhone' : 'Android';
    }
  }

  Future<void> _registerWithSygnal({
    required String pushkey,
    required String appId,
    required String kind,
  }) async {
    if (_homeserverUrl == null || _matrixAccessToken == null) return;

    final deviceName = await _resolveDeviceName();

    final body = {
      'kind': kind,
      'app_id': appId,
      'app_display_name': 'StuRaOS',
      'device_display_name': deviceName,
      'pushkey': pushkey,
      'lang': 'en',
      'data': {
        'url': sygnalUrl,
        'format': 'event_id_only', // summary-only — no message content
      },
    };

    try {
      await http.put(
        Uri.parse('$_homeserverUrl/_matrix/client/v3/pushers/set'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $_matrixAccessToken',
        },
        body: jsonEncode(body),
      );
    } catch (e) {
      developer.log('Sygnal registration failed',
          name: 'PushService', error: e);
    }
  }

  /// #233: remove every pusher this device registered (UnifiedPush) so a
  /// logged-out account stops receiving notifications. Best-effort — failures
  /// are logged and swallowed so an offline logout still proceeds. Runs
  /// whatever [enabled] says: a build without the flag may follow one that
  /// registered a UnifiedPush pusher.
  ///
  /// MUST run BEFORE the Matrix token is revoked (MatrixService.logout()):
  /// /pushers/set is authenticated with [_matrixAccessToken], which becomes
  /// invalid after logout, so deregistering afterwards would silently 401 and
  /// leave the pushers live.
  Future<void> deregisterAll() async {
    if (Platform.isAndroid) {
      try {
        // Fires onUnregistered → _deregisterFromSygnal for the UnifiedPush id.
        await UnifiedPush.unregister();
      } catch (e) {
        developer.log('UnifiedPush unregister failed',
            name: 'PushService', error: e);
      }
    }
  }

  Future<void> _deregisterFromSygnal(
      {required String appId, String pushkey = ''}) async {
    if (_homeserverUrl == null || _matrixAccessToken == null) return;
    try {
      await http
          .put(
            Uri.parse('$_homeserverUrl/_matrix/client/v3/pushers/set'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $_matrixAccessToken',
            },
            body: jsonEncode({
              'kind': null,
              'app_id': appId,
              'pushkey': pushkey,
            }),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {}
  }

  Future<void> _showLocalNotification() async {
    await _localNotifications.show(
      _androidChannel.id.hashCode,
      'StuRaOS',
      // Summary-only — never show message body from payload
      'You have a new message',
      NotificationDetails(
        android: AndroidNotificationDetails(
          _androidChannel.id,
          _androidChannel.name,
          channelDescription: _androidChannel.description,
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: const DarwinNotificationDetails(),
      ),
    );
  }
}
