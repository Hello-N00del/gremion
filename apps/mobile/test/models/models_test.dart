import 'package:flutter_test/flutter_test.dart';
import 'package:stura/models/user_session.dart';
import 'package:stura/models/nc_file.dart';
import 'package:stura/models/poll.dart';
import 'package:stura/models/calendar_event.dart';

void main() {
  group('UserSession', () {
    test('fromJson parses all fields', () {
      final session = UserSession.fromJson({
        'access_token': 'at',
        'refresh_token': 'rt',
        'id_token': 'idt',
        'role': 'member',
        'matrix_user_id': '@alice:stura.example.com',
        'homeserver_url': 'https://matrix.stura.example.com',
      });
      expect(session.accessToken, 'at');
      expect(session.role, StuRaRole.member);
      expect(session.matrixUserId, '@alice:stura.example.com');
    });
  });

  group('NcFile', () {
    test('fromWebDav parses locked file', () {
      final file = NcFile.fromWebDav(
        path: '/files/rules-of-procedure.pdf',
        name: 'rules-of-procedure.pdf',
        isDir: false,
        isLocked: true,
        etag: 'abc123',
        size: 1024,
        lastModified: DateTime(2026, 3, 1),
      );
      expect(file.isLocked, true);
      expect(file.name, 'rules-of-procedure.pdf');
    });
  });

  group('Poll', () {
    test('fromJson round-trips', () {
      final poll = Poll.fromJson({
        'id': 'poll-1',
        'title': 'Meeting location?',
        'options': ['Room A', 'Room B'],
        'deadline': '2026-04-01T12:00:00Z',
        'group_id': 'council',
        'voted': false,
      });
      expect(poll.options.length, 2);
      expect(poll.voted, false);
    });
  });

  group('CalendarEvent', () {
    test('fromJson parses the gateway DbEvent shape (id/startAt/endAt)', () {
      final e = CalendarEvent.fromJson({
        'id': 'evt-1',
        'title': 'Council Meeting',
        'startAt': '2026-04-01T14:00:00.000Z',
        'endAt': '2026-04-01T16:00:00.000Z',
        'location': 'Room 101',
        'description': null,
      });
      expect(e.uid, 'evt-1');
      expect(e.title, 'Council Meeting');
      expect(e.start, DateTime.utc(2026, 4, 1, 14, 0));
      expect(e.end, DateTime.utc(2026, 4, 1, 16, 0));
      expect(e.location, 'Room 101');
      expect(e.description, isNull);
    });

    test('toJson emits the create/update keys (startAt/endAt, no id)', () {
      final json = CalendarEvent(
        uid: 'evt-1',
        title: 'Council Meeting',
        start: DateTime.utc(2026, 4, 1, 14, 0),
        end: DateTime.utc(2026, 4, 1, 16, 0),
        location: 'Room 101',
        description: null,
      ).toJson();
      expect(json['startAt'], '2026-04-01T14:00:00.000Z');
      expect(json['endAt'], '2026-04-01T16:00:00.000Z');
      expect(json['title'], 'Council Meeting');
      expect(json['location'], 'Room 101');
      expect(json.containsKey('id'), false); // server-assigned / in URL
      expect(json.containsKey('uid'), false);
      expect(json.containsKey('description'), false); // null omitted
    });
  });
}
