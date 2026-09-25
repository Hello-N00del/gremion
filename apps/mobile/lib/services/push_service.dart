import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:unifiedpush/unifiedpush.dart';

/// Handles push notification registration (FCM + APNs + UnifiedPush)
/// and registers the push token with Sygnal via the Matrix CS API pusher endpoint.
class PushService {
  PushService({required this.sygnalUrl});

  final String sygnalUrl;

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
    await _initLocalNotifications();
    await _initFcm();
    // UnifiedPush: Android-only fallback (no-op on iOS)
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
  }

  Future<void> _initFcm() async {
    // Request permission
    final settings = await FirebaseMessaging.instance.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    if (settings.authorizationStatus == AuthorizationStatus.denied) return;

    final fcmAppId =
        Platform.isIOS ? 'com.stura.app.ios' : 'com.stura.app.android';

    final token = await FirebaseMessaging.instance.getToken();
    if (token != null) {
      await _registerWithSygnal(pushkey: token, appId: fcmAppId, kind: 'http');
    }

    // Refresh token handler
    FirebaseMessaging.instance.onTokenRefresh.listen((newToken) {
      _registerWithSygnal(pushkey: newToken, appId: fcmAppId, kind: 'http');
    });

    // Foreground message display
    FirebaseMessaging.onMessage.listen(_showLocalNotification);

    // Background message handler registered in main.dart
    FirebaseMessaging.onBackgroundMessage(_backgroundMessageHandler);
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
        _showLocalNotification(const RemoteMessage(
          notification: RemoteNotification(
            title: 'StuRaOS',
            body: 'You have a new message',
          ),
        ));
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

  /// #233: remove every pusher this device registered (FCM/APNs + UnifiedPush)
  /// so a logged-out account stops receiving notifications. Best-effort — each
  /// deregister is independent and failures are swallowed so an offline logout
  /// still proceeds.
  ///
  /// MUST run BEFORE the Matrix token is revoked (MatrixService.logout()):
  /// /pushers/set is authenticated with [_matrixAccessToken], which becomes
  /// invalid after logout, so deregistering afterwards would silently 401 and
  /// leave the pushers live.
  Future<void> deregisterAll() async {
    final fcmAppId =
        Platform.isIOS ? 'com.stura.app.ios' : 'com.stura.app.android';
    try {
      // Delete the pusher keyed by the current FCM token, then invalidate the
      // token locally so a re-login mints a clean one.
      final fcmToken = await FirebaseMessaging.instance.getToken();
      if (fcmToken != null && fcmToken.isNotEmpty) {
        await _deregisterFromSygnal(appId: fcmAppId, pushkey: fcmToken);
      }
      await FirebaseMessaging.instance.deleteToken();
    } catch (e) {
      developer.log('FCM deregister failed', name: 'PushService', error: e);
    }
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

  Future<void> _showLocalNotification(RemoteMessage message) async {
    final notification = message.notification;
    if (notification == null) return;

    await _localNotifications.show(
      notification.hashCode,
      notification.title ?? 'StuRaOS',
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

/// Top-level handler for background FCM messages (must be top-level function).
@pragma('vm:entry-point')
Future<void> _backgroundMessageHandler(RemoteMessage message) async {
  // Background messages: notification will be shown by FCM directly.
  // No action needed here beyond ensuring Firebase is initialized.
}
