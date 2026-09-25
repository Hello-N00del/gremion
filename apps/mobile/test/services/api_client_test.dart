// mobile/test/services/api_client_test.dart
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:stura/models/calendar_event.dart';
import 'package:stura/services/api_client.dart';

void main() {
  test('listFiles returns NcFile list on 200', () async {
    final client = StuRaOSApiClient(
      baseUrl: 'http://localhost',
      accessToken: 'tok',
      mockHttp: MockClient((req) async {
        expect(req.headers['Authorization'], 'Bearer tok');
        return http.Response(
          jsonEncode({
            'files': [
              {
                'path': '/a.pdf',
                'name': 'a.pdf',
                'is_dir': false,
                'is_locked': false,
                'etag': 'e1',
                'size': 100,
                'last_modified': '2026-03-01T00:00:00Z'
              }
            ]
          }),
          200,
        );
      }),
    );
    final files = await client.listFiles('/');
    expect(files.length, 1);
    expect(files.first.name, 'a.pdf');
  });

  test('getPolls returns Poll list on 200', () async {
    final client = StuRaOSApiClient(
      baseUrl: 'http://localhost',
      accessToken: 'tok',
      mockHttp: MockClient((req) async => http.Response(
            jsonEncode({
              'polls': [
                {
                  'id': 'p1',
                  'title': 'Venue?',
                  'options': ['A', 'B'],
                  'deadline': '2026-04-01T00:00:00Z',
                  'group_id': 'g1',
                  'voted': false
                }
              ]
            }),
            200,
          )),
    );
    final polls = await client.getPolls();
    expect(polls.length, 1);
    expect(polls.first.title, 'Venue?');
  });

  test('throws StuRaApiException on 403', () async {
    final client = StuRaOSApiClient(
      baseUrl: 'http://localhost',
      accessToken: 'tok',
      mockHttp: MockClient((_) async => http.Response(
            jsonEncode({'error': 'Forbidden'}),
            403,
          )),
    );
    expect(
        () => client.listFiles('/locked'), throwsA(isA<StuRaApiException>()));
  });

  // #246: pin the mobile calendar client's HTTP method+path to the SvelteKit
  // gateway route exports so a divergence (like the old POST /api/calendar/$uid
  // that 405'd/404'd) fails a test instead of a user action. Gateway exports:
  //   /api/calendar/events        → GET, POST
  //   /api/calendar/events/[id]   → GET, PATCH, DELETE
  group('calendar client route contract (#246)', () {
    final sample = CalendarEvent(
      uid: 'evt-1',
      title: 'Sitzung',
      start: DateTime.utc(2026, 4, 1, 10),
      end: DateTime.utc(2026, 4, 1, 11),
    );
    // The gateway's {success,data:DbEvent} echo (id/startAt/endAt keys).
    final dbEvent = <String, dynamic>{
      'id': 'evt-1',
      'title': 'Sitzung',
      'startAt': '2026-04-01T10:00:00.000Z',
      'endAt': '2026-04-01T11:00:00.000Z',
    };

    test('getEvents → GET /api/calendar/events', () async {
      late String method;
      late String path;
      final client = StuRaOSApiClient(
        baseUrl: 'http://localhost',
        accessToken: 'tok',
        mockHttp: MockClient((req) async {
          method = req.method;
          path = req.url.path;
          return http.Response(jsonEncode({'data': <dynamic>[]}), 200);
        }),
      );
      await client.getEvents();
      expect(method, 'GET');
      expect(path, '/api/calendar/events');
    });

    test('createEvent → POST /api/calendar/events (body startAt/endAt, parses envelope)',
        () async {
      late String method;
      late String path;
      late Map<String, dynamic> body;
      final client = StuRaOSApiClient(
        baseUrl: 'http://localhost',
        accessToken: 'tok',
        mockHttp: MockClient((req) async {
          method = req.method;
          path = req.url.path;
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(jsonEncode({'success': true, 'data': dbEvent}), 201);
        }),
      );
      final created = await client.createEvent(sample);
      expect(method, 'POST');
      expect(path, '/api/calendar/events');
      // #246: body must carry the gateway's startAt/endAt keys, not start/end.
      expect(body['startAt'], '2026-04-01T10:00:00.000Z');
      expect(body['endAt'], '2026-04-01T11:00:00.000Z');
      expect(body.containsKey('id'), false);
      expect(created.uid, 'evt-1'); // parsed back from the {data:{id}} envelope
    });

    test('updateEvent → PATCH /api/calendar/events/<uid> (body startAt/endAt, parses envelope)',
        () async {
      late String method;
      late String path;
      late Map<String, dynamic> body;
      final client = StuRaOSApiClient(
        baseUrl: 'http://localhost',
        accessToken: 'tok',
        mockHttp: MockClient((req) async {
          method = req.method;
          path = req.url.path;
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(jsonEncode({'success': true, 'data': dbEvent}), 200);
        }),
      );
      final result = await client.updateEvent(sample);
      expect(method, 'PATCH');
      expect(path, '/api/calendar/events/evt-1');
      // #246: the time edit is carried as startAt/endAt (updateSchema keys) so
      // it no longer no-ops, and the {success,data:DbEvent} echo is parsed back.
      expect(body['startAt'], '2026-04-01T10:00:00.000Z');
      expect(body['endAt'], '2026-04-01T11:00:00.000Z');
      expect(result.uid, 'evt-1');
    });

    test('deleteEvent → DELETE /api/calendar/events/<uid>', () async {
      late String method;
      late String path;
      final client = StuRaOSApiClient(
        baseUrl: 'http://localhost',
        accessToken: 'tok',
        mockHttp: MockClient((req) async {
          method = req.method;
          path = req.url.path;
          return http.Response('', 200);
        }),
      );
      await client.deleteEvent('evt-1');
      expect(method, 'DELETE');
      expect(path, '/api/calendar/events/evt-1');
    });

    test('deleteEvent percent-encodes the uid path segment', () async {
      late String rawPath;
      final client = StuRaOSApiClient(
        baseUrl: 'http://localhost',
        accessToken: 'tok',
        mockHttp: MockClient((req) async {
          // req.url.path is decoded; use the raw path to see the encoding.
          rawPath = req.url.toString();
          return http.Response('', 200);
        }),
      );
      await client.deleteEvent('a b/c');
      expect(rawPath, contains('/api/calendar/events/a%20b%2Fc'));
    });
  });
}
