// mobile/test/widgets/role_guard_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:provider/provider.dart';
import 'package:stura/models/user_session.dart';
import 'package:stura/services/auth_service.dart';
import 'package:stura/widgets/role_guard.dart';

class MockAuthService extends Mock implements AuthService {}

Widget _wrap(Widget child, StuRaRole role) {
  final auth = MockAuthService();
  when(() => auth.session).thenReturn(UserSession(
    accessToken: 'a',
    refreshToken: 'r',
    idToken: 'i',
    role: role,
    matrixUserId: '@u:h',
    matrixDeviceId: 'DEV1',
    matrixToken: 'mt',
    homeserverUrl: 'http://h',
  ));
  when(() => auth.isAuthenticated).thenReturn(true);
  return ChangeNotifierProvider<AuthService>.value(
      value: auth, child: MaterialApp(home: child));
}

void main() {
  testWidgets('shows child when role is sufficient', (tester) async {
    await tester.pumpWidget(_wrap(
      const RoleGuard(minRole: StuRaRole.member, child: Text('visible')),
      StuRaRole.member,
    ));
    expect(find.text('visible'), findsOneWidget);
  });

  testWidgets('hides child when role is insufficient', (tester) async {
    await tester.pumpWidget(_wrap(
      const RoleGuard(minRole: StuRaRole.member, child: Text('hidden')),
      StuRaRole.guest,
    ));
    expect(find.text('hidden'), findsNothing);
  });
}
