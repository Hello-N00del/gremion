import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:provider/provider.dart';
import 'package:stura/models/poll.dart';
import 'package:stura/models/user_session.dart';
import 'package:stura/screens/polls/polls_screen.dart';
import 'package:stura/services/api_client.dart';
import 'package:stura/services/auth_service.dart';

class MockApiClient extends Mock implements StuRaOSApiClient {}

class MockAuthService extends Mock implements AuthService {}

void main() {
  testWidgets('shows polls from api', (tester) async {
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
    when(() => api.getPolls()).thenAnswer((_) async => [
          Poll.fromJson({
            'id': 'p1',
            'title': 'Next meeting?',
            'options': ['Mon', 'Tue'],
            'deadline': '2099-01-01T00:00:00Z',
            'group_id': 'g',
            'voted': false
          }),
        ]);
    await tester.pumpWidget(MultiProvider(
      providers: [
        Provider<StuRaOSApiClient>.value(value: api),
        ChangeNotifierProvider<AuthService>.value(value: auth),
      ],
      child: const MaterialApp(home: PollsScreen()),
    ));
    await tester.pump();
    expect(find.text('Next meeting?'), findsOneWidget);
  });
}
