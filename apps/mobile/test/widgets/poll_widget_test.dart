import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:provider/provider.dart';
import 'package:stura/models/poll.dart';
import 'package:stura/services/api_client.dart';
import 'package:stura/widgets/poll_widget.dart';

class MockApiClient extends Mock implements StuRaOSApiClient {}

void main() {
  final poll = Poll.fromJson({
    'id': 'p1',
    'title': 'Venue?',
    'options': [
      {'id': 'a', 'text': 'Room A', 'votes': 3},
      {'id': 'b', 'text': 'Room B', 'votes': 1},
    ],
    'deadline': '2099-01-01T00:00:00Z',
    'group_id': 'g',
    'voted': false,
  });

  testWidgets('shows poll title and options', (tester) async {
    final api = MockApiClient();
    await tester.pumpWidget(Provider<StuRaOSApiClient>.value(
        value: api,
        child: MaterialApp(home: Scaffold(body: PollWidget(poll: poll)))));
    expect(find.text('Venue?'), findsOneWidget);
    expect(find.text('Room A'), findsOneWidget);
    expect(find.text('Room B'), findsOneWidget);
  });

  testWidgets('calls votePoll on option tap', (tester) async {
    final api = MockApiClient();
    when(() => api.votePoll('p1', 'a')).thenAnswer((_) async {});
    await tester.pumpWidget(Provider<StuRaOSApiClient>.value(
        value: api,
        child: MaterialApp(home: Scaffold(body: PollWidget(poll: poll)))));
    await tester.tap(find.text('Room A'));
    await tester.pump();
    verify(() => api.votePoll('p1', 'a')).called(1);
  });
}
