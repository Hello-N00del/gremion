import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:provider/provider.dart';
import 'package:stura/models/nc_file.dart';
import 'package:stura/models/user_session.dart';
import 'package:stura/screens/files/files_screen.dart';
import 'package:stura/services/api_client.dart';
import 'package:stura/services/auth_service.dart';

class MockApiClient extends Mock implements StuRaOSApiClient {}

class MockAuthService extends Mock implements AuthService {}

void main() {
  testWidgets('shows file list returned by api', (tester) async {
    final api = MockApiClient();
    final auth = MockAuthService();
    when(() => auth.session).thenReturn(const UserSession(
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      role: StuRaRole.member,
      matrixUserId: '@u:h',
      matrixDeviceId: 'DEV1',
      matrixToken: 'mt',
      homeserverUrl: 'http://h',
    ));
    when(() => api.listFiles('/')).thenAnswer((_) async => [
          NcFile.fromWebDav(
              path: '/report.pdf',
              name: 'report.pdf',
              isDir: false,
              isLocked: false,
              etag: 'e',
              size: 512,
              lastModified: DateTime(2026)),
        ]);
    await tester.pumpWidget(MultiProvider(
      providers: [
        Provider<StuRaOSApiClient>.value(value: api),
        ChangeNotifierProvider<AuthService>.value(value: auth),
      ],
      child: const MaterialApp(home: FilesScreen()),
    ));
    await tester.pump();
    expect(find.text('report.pdf'), findsOneWidget);
  });

  testWidgets('shows lock badge for locked files', (tester) async {
    final api = MockApiClient();
    final auth = MockAuthService();
    when(() => auth.session).thenReturn(const UserSession(
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      role: StuRaRole.member,
      matrixUserId: '@u:h',
      matrixDeviceId: 'DEV1',
      matrixToken: 'mt',
      homeserverUrl: 'http://h',
    ));
    when(() => api.listFiles('/')).thenAnswer((_) async => [
          NcFile.fromWebDav(
              path: '/rules.pdf',
              name: 'rules.pdf',
              isDir: false,
              isLocked: true,
              etag: 'e',
              size: 512,
              lastModified: DateTime(2026)),
        ]);
    await tester.pumpWidget(MultiProvider(
      providers: [
        Provider<StuRaOSApiClient>.value(value: api),
        ChangeNotifierProvider<AuthService>.value(value: auth),
      ],
      child: const MaterialApp(home: FilesScreen()),
    ));
    await tester.pump();
    expect(find.byIcon(Icons.lock_outline), findsOneWidget);
  });
}
