// mobile/lib/services/api_client.dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/nc_file.dart';
import '../models/nc_file_version.dart';
import '../models/calendar_event.dart';
import '../models/poll.dart';
import '../models/election.dart';
import '../models/group.dart';
import '../models/finance_summary.dart';
import '../models/deck_card.dart';

class StuRaApiException implements Exception {
  final int statusCode;
  final String message;
  const StuRaApiException({required this.statusCode, required this.message});
  @override
  String toString() => 'StuRaApiException($statusCode): $message';
}

class StuRaOSApiClient {
  StuRaOSApiClient({
    required this.baseUrl,
    required this.accessToken,
    http.Client? mockHttp,
  }) : _http = mockHttp ?? http.Client();

  final String baseUrl;
  String accessToken;
  final http.Client _http;
  static const _kTimeout = Duration(seconds: 30);

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $accessToken',
      };

  Future<Map<String, dynamic>> _get(String path) async {
    final res = await _http
        .get(Uri.parse('$baseUrl$path'), headers: _headers)
        .timeout(_kTimeout);
    return _handle(res);
  }

  Future<Map<String, dynamic>> _post(
      String path, Map<String, dynamic> body) async {
    final res = await _http
        .post(Uri.parse('$baseUrl$path'),
            headers: _headers, body: jsonEncode(body))
        .timeout(_kTimeout);
    return _handle(res);
  }

  Future<Map<String, dynamic>> _patch(
      String path, Map<String, dynamic> body) async {
    final res = await _http
        .patch(Uri.parse('$baseUrl$path'),
            headers: _headers, body: jsonEncode(body))
        .timeout(_kTimeout);
    return _handle(res);
  }

  Future<void> _delete(String path) async {
    final res = await _http
        .delete(Uri.parse('$baseUrl$path'), headers: _headers)
        .timeout(_kTimeout);
    _handle(res);
  }

  Map<String, dynamic> _handle(http.Response res) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (res.body.isEmpty) return {};
      final decoded = jsonDecode(res.body);
      if (decoded is! Map<String, dynamic>) {
        throw StuRaApiException(
          statusCode: res.statusCode,
          message:
              'Unexpected response shape: expected JSON object, got ${decoded.runtimeType}',
        );
      }
      return decoded;
    }
    final msg = _extractErrorMessage(res);
    throw StuRaApiException(statusCode: res.statusCode, message: msg);
  }

  String _extractErrorMessage(http.Response res) {
    try {
      final body = jsonDecode(res.body);
      if (body is Map && body['error'] is String) {
        return body['error'] as String;
      }
    } catch (_) {}
    return res.body.isEmpty ? 'HTTP ${res.statusCode}' : res.body;
  }

  // ── Files (Nextcloud WebDAV via SvelteKit proxy) ────────────────────────────

  Future<List<NcFile>> listFiles(String path) async {
    final segments = path
        .split('/')
        .where((s) => s.isNotEmpty)
        .map(Uri.encodeComponent)
        .join('/');
    final j = await _get('/api/files/$segments');
    return (j['files'] as List)
        .map((f) => NcFile.fromWebDav(
              path: f['path'] as String,
              name: f['name'] as String,
              isDir: f['is_dir'] as bool,
              isLocked: (f['is_locked'] as bool?) ?? false,
              etag: (f['etag'] as String?) ?? '',
              size: (f['size'] as int?) ?? 0,
              lastModified:
                  DateTime.tryParse(f['last_modified'] as String? ?? '') ??
                      DateTime.now(),
            ))
        .toList();
  }

  Future<List<int>> downloadFile(String path) async {
    // Server route is /api/files/[...path] — file path must be in the URL,
    // not a query param. The server detects files by checking for an extension.
    final segments = path
        .split('/')
        .where((s) => s.isNotEmpty)
        .map(Uri.encodeComponent)
        .join('/');
    final res = await _http
        .get(
          Uri.parse('$baseUrl/api/files/$segments'),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 120));
    if (res.statusCode != 200) {
      throw StuRaApiException(
        statusCode: res.statusCode,
        message: _extractErrorMessage(res),
      );
    }
    return res.bodyBytes;
  }

  Future<void> uploadFile(
      String dirPath, String fileName, List<int> bytes) async {
    final req = http.MultipartRequest(
      'POST',
      Uri.parse('$baseUrl/api/files/upload'),
    )
      ..headers['Authorization'] =
          'Bearer $accessToken' // only auth — MultipartRequest sets its own Content-Type
      ..fields['path'] = dirPath
      ..files
          .add(http.MultipartFile.fromBytes('file', bytes, filename: fileName));
    // #261: send through the injected _http client (so the mockHttp test seam
    // actually covers uploads) and apply a timeout (mirrors downloadFile's
    // 120s) so a stalled upload can't hang the files screen forever.
    final streamed =
        await _http.send(req).timeout(const Duration(seconds: 120));
    if (streamed.statusCode >= 400) {
      throw StuRaApiException(
          statusCode: streamed.statusCode, message: 'Upload failed');
    }
  }

  Future<void> createFolder(String path) =>
      _post('/api/files/mkdir', {'path': path}).then((_) {});
  Future<void> renameFile(String path, String newName) =>
      _post('/api/files/rename', {'path': path, 'new_name': newName})
          .then((_) {});
  Future<void> deleteFile(String path) =>
      _delete('/api/files?path=${Uri.encodeComponent(path)}');

  Future<List<NcFileVersion>> getFileVersions(String path) async {
    final j =
        await _get('/api/files/versions?path=${Uri.encodeComponent(path)}');
    return (j['versions'] as List)
        .map((v) => NcFileVersion.fromJson(v as Map<String, dynamic>))
        .toList();
  }

  Future<void> restoreFileVersion(String path, String versionId) => _post(
      '/api/files/versions/restore',
      {'path': path, 'version_id': versionId}).then((_) {});

  // ── Calendar ────────────────────────────────────────────────────────────────

  Future<List<CalendarEvent>> getEvents({DateTime? from, DateTime? to}) async {
    var path = '/api/calendar/events';
    final params = <String>[];
    if (from != null) {
      params.add('from=${Uri.encodeComponent(from.toIso8601String())}');
    }
    if (to != null) {
      params.add('to=${Uri.encodeComponent(to.toIso8601String())}');
    }
    if (params.isNotEmpty) path += '?${params.join('&')}';
    final j = await _get(path);
    return ((j['data'] ?? j['events']) as List? ?? [])
        .map((e) => CalendarEvent.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<CalendarEvent> createEvent(CalendarEvent event) async {
    final j = await _post('/api/calendar/events', event.toJson());
    return CalendarEvent.fromJson((j['data'] ?? j) as Map<String, dynamic>);
  }

  // #246: PATCH /api/calendar/events/[id] — matches the gateway route exports
  // (GET/PATCH/DELETE). The body carries startAt/endAt via CalendarEvent.toJson
  // (the updateSchema keys), and the {success,data} DbEvent envelope is parsed
  // back through the now-aligned fromJson (id/startAt/endAt).
  Future<CalendarEvent> updateEvent(CalendarEvent event) async {
    final j = await _patch(
        '/api/calendar/events/${Uri.encodeComponent(event.uid)}',
        event.toJson());
    return CalendarEvent.fromJson((j['data'] ?? j) as Map<String, dynamic>);
  }

  // #246: DELETE /api/calendar/events/[id] — the previous /api/calendar/$uid
  // path did not exist on the gateway and 404'd.
  Future<void> deleteEvent(String uid) =>
      _delete('/api/calendar/events/${Uri.encodeComponent(uid)}');

  // ── Polls ───────────────────────────────────────────────────────────────────
  // B6: SvelteKit /api/polls should proxy to Nextcloud Polls API at:
  //   /index.php/apps/polls/api/v1.0/   ← CORRECT (verified)
  //   /ocs/v2.php/apps/polls/api/v1/    ← WRONG (returns 404)

  Future<List<Poll>> getPolls() async {
    final j = await _get('/api/polls');
    return ((j['data'] ?? j['polls']) as List? ?? [])
        .map((p) => Poll.fromJson(p as Map<String, dynamic>))
        .toList();
  }

  Future<Poll> getPollDetail(String pollId) async {
    final j = await _get('/api/polls/$pollId');
    return Poll.fromJson((j['data'] ?? j) as Map<String, dynamic>);
  }

  Future<void> votePoll(String pollId, String optionId) =>
      _post('/api/polls/$pollId', {'optionId': optionId}).then((_) {});

  Future<Poll> createPoll(String title, List<String> options, DateTime deadline,
      String groupId) async {
    final j = await _post('/api/polls', {
      'title': title,
      'options': options,
      'deadline': deadline.toIso8601String(),
      'group_id': groupId,
    });
    return Poll.fromJson(j);
  }

  // ── Elections ───────────────────────────────────────────────────────────────

  Future<List<Election>> getElections() async {
    final j = await _get('/api/elections');
    return ((j['data'] ?? j['elections']) as List? ?? [])
        .map((e) => Election.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  // ── Groups ──────────────────────────────────────────────────────────────────

  // Admin endpoint — requires council-admin or it-admin role (enforced server-side by SvelteKit route).
  Future<List<Group>> getGroups() async {
    final j = await _get('/api/groups');
    return ((j['data'] ?? j['groups']) as List? ?? [])
        .map((g) => Group.fromJson(g as Map<String, dynamic>))
        .toList();
  }

  // ── Finance summary (HOME dashboard KPIs) ────────────────────────────────────

  /// Dashboard finance aggregate for the HOME screen. The route is
  /// finance-gated server-side; a 403 means the signed-in user has no finance
  /// role, so we return null and the HOME screen hides the finance KPI tiles.
  Future<FinanceSummary?> getFinanceSummary() async {
    try {
      final j = await _get('/api/finance/summary');
      final data = (j['data'] ?? j) as Map<String, dynamic>;
      return FinanceSummary.fromJson(data);
    } on StuRaApiException catch (e) {
      if (e.statusCode == 403) return null;
      rethrow;
    }
  }

  // ── Deck / Aufgaben (Nextcloud-Deck-style task boards) ───────────────────────
  // Binds the existing gremion-ui board routes (no new backend):
  //   GET /api/board            → { data: Board[] }   (member-gated, OU-scoped)
  //   GET /api/board/[id]       → { data: { board, stacks, cards } }
  // Note: the board's cards are only exposed alongside their stacks via the
  // board-detail route; /api/board/[id]/cards is POST/PATCH only (no GET), so
  // the full deck is read through GET /api/board/[id].

  /// Boards the current user may see (org-unit scoped server-side). The route
  /// already filters out archived boards. A 403 (no member role) surfaces as a
  /// StuRaApiException for the caller to render an empty/blocked state.
  Future<List<Board>> getBoards() async {
    final j = await _get('/api/board');
    return ((j['data'] ?? j['boards']) as List? ?? [])
        .map((b) => Board.fromJson(b as Map<String, dynamic>))
        .toList();
  }

  /// One board's full deck: board + stacks (columns) + cards. The card's stack
  /// is its status. Server-gated to org-units the user is scoped to.
  Future<Deck> getBoardDeck(String boardId) async {
    final j = await _get('/api/board/${Uri.encodeComponent(boardId)}');
    return Deck.fromJson((j['data'] ?? j) as Map<String, dynamic>);
  }
}
