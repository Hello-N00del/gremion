// mobile/lib/screens/home/home_screen.dart
//
// HOME dashboard (Design v8 Part G — de-financed). Ports the handoff `MHome`
// (design_files/mobile/mobile-app.jsx:4-86) onto Flutter + GremionTokens:
// greeting head, dark-hero next-event card with live countdown, a member KPI
// row ("Meine Aufgaben · im Deck" / "Ungelesen · Matrix"), an "Anstehend"
// upcoming list and "Laufende Abstimmungen" live votes. Data comes from
// existing endpoints (calendar / elections / board deck) plus the live Matrix
// unread count — no finance on the member home (finance is a web/admin
// surface).
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/calendar_event.dart';
import '../../models/election.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../services/matrix_service.dart';
import '../../tokens/design_tokens.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<CalendarEvent> _upcoming = [];
  List<Election> _liveVotes = [];

  /// Count of board cards across all visible boards assigned to the signed-in
  /// user (matched by Keycloak `sub`). Drives "Meine Aufgaben". -1 = unknown
  /// (deck fetch failed / not loaded yet) so the KPI can render "—".
  int _myTasks = -1;
  bool _loading = true;
  String? _error;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // 1-second ticker drives the next-event countdown. Cheap setState of a
    // single Text; cancelled in dispose.
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _upcoming.isNotEmpty) setState(() {});
    });
    _load();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final api = context.read<StuRaOSApiClient>();
    final myKeycloakId = _subFromIdToken(
        context.read<AuthService>().session?.accessToken ??
            context.read<AuthService>().session?.idToken);
    try {
      final now = DateTime.now();
      final results = await Future.wait([
        api.getEvents(from: now, to: now.add(const Duration(days: 60))),
        api.getElections(),
        _countMyTasks(api, myKeycloakId),
      ]);
      final events = (results[0] as List<CalendarEvent>)
          .where((e) => e.end.isAfter(now))
          .toList()
        ..sort((a, b) => a.start.compareTo(b.start));
      final elections = (results[1] as List<Election>)
          .where((e) => e.status == ElectionStatus.active)
          .toList();
      if (!mounted) return;
      setState(() {
        _upcoming = events;
        _liveVotes = elections;
        _myTasks = results[2] as int;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  /// Counts board cards assigned to [myKeycloakId] across every board the user
  /// can see. Resolved as a side fetch so a deck failure (e.g. a member with no
  /// board scope → 403) degrades to "—" rather than blanking the whole home
  /// screen. Returns -1 when the count can't be determined.
  Future<int> _countMyTasks(StuRaOSApiClient api, String? myKeycloakId) async {
    if (myKeycloakId == null || myKeycloakId.isEmpty) return -1;
    try {
      final boards = await api.getBoards();
      if (boards.isEmpty) return 0;
      final decks =
          await Future.wait(boards.map((b) => api.getBoardDeck(b.id)));
      var count = 0;
      for (final deck in decks) {
        count += deck.cards
            .where((c) => c.assigneeKeycloakId == myKeycloakId)
            .length;
      }
      return count;
    } catch (_) {
      return -1;
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final session = context.read<AuthService>().session;
    final firstName = _firstNameFromIdToken(session?.idToken);
    // Live Matrix unread total — same source as the tab-bar dot and the chat
    // list (sum of room.notificationCount). Watched so the KPI/sub update on
    // sync.
    final unread = _unreadCount(context.watch<MatrixService>());

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? _ErrorView(message: _error!, onRetry: _load)
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(GremionTokens.s4,
                          GremionTokens.s5, GremionTokens.s4, GremionTokens.s8),
                      children: [
                        _head(muted, firstName, unread),
                        const SizedBox(height: GremionTokens.s4),
                        _nextEventHero(),
                        const SizedBox(height: GremionTokens.s4),
                        _kpiRow(muted, unread),
                        const SizedBox(height: GremionTokens.s6),
                        _sectionTitle('Anstehend'),
                        const SizedBox(height: GremionTokens.s2),
                        _upcomingList(muted),
                        const SizedBox(height: GremionTokens.s6),
                        _sectionTitle('Laufende Abstimmungen'),
                        const SizedBox(height: GremionTokens.s2),
                        _liveVotesList(muted),
                      ],
                    ),
                  ),
      ),
    );
  }

  // ── Page head ──────────────────────────────────────────────────────────
  Widget _head(Color muted, String firstName, int unread) {
    // Prototype sub-line (mobile-app.jsx:16):
    // "{myTasks} Aufgaben · {liveVotes} Abstimmungen · {unread} ungelesen".
    // When the task count is unknown (_myTasks < 0, e.g. a board-scope 403),
    // omit the "Aufgaben" segment entirely rather than coercing it to "0",
    // matching the KPI card which shows "—" for the same unknown value.
    final votes = _liveVotes.length;
    final sub = [
      if (_myTasks >= 0) '$_myTasks Aufgaben',
      '$votes Abstimmungen',
      '$unread ungelesen',
    ].join(' · ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(_greeting(), style: _eyebrow(muted)),
        const SizedBox(height: 4),
        Text(
          firstName.isEmpty ? 'Willkommen.' : '$firstName.',
          style: TextStyle(
            fontFamily: GremionTokens.fontDisplay,
            fontSize: 30,
            fontWeight: FontWeight.w500,
            height: 1.1,
            color: Theme.of(context).colorScheme.onSurface,
          ),
        ),
        const SizedBox(height: 6),
        Text(sub, style: TextStyle(fontSize: 13.5, color: muted)),
      ],
    );
  }

  // ── Dark-hero next-event card ────────────────────────────────────────────
  Widget _nextEventHero() {
    final next = _upcoming.isNotEmpty ? _upcoming.first : null;
    final onDark = GremionTokens.inkDark;
    final mutedOnDark = GremionTokens.inkMutedDark;
    return Container(
      width: double.infinity,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: GremionTokens.surfaceDark,
        borderRadius: GremionTokens.rLg,
        border: Border.all(color: GremionTokens.borderStrongDark),
      ),
      child: Stack(
        children: [
          // Ember hero accent stripe (mobile.css:75 — .dark-hero::before).
          Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            child: Container(width: 3, color: GremionTokens.ember),
          ),
          Padding(
            padding: const EdgeInsets.all(GremionTokens.s5),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Nächster Termin', style: _eyebrow(mutedOnDark)),
                    if (next != null && _isToday(next.start))
                      _pill('HEUTE', GremionTokens.emberDark,
                          GremionTokens.emberSoftDark),
                  ],
                ),
                const SizedBox(height: GremionTokens.s2),
                Text(
                  next?.title ?? 'Keine anstehenden Termine',
                  style: TextStyle(
                    fontFamily: GremionTokens.fontDisplay,
                    fontSize: 20,
                    fontWeight: FontWeight.w500,
                    height: 1.15,
                    color: onDark,
                  ),
                ),
                if (next?.location != null && next!.location!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(next.location!,
                      style: TextStyle(fontSize: 12.5, color: mutedOnDark)),
                ],
                if (next != null) ...[
                  const SizedBox(height: GremionTokens.s3),
                  Text(
                    _countdown(next.start),
                    style: TextStyle(
                      fontFamily: GremionTokens.fontMono,
                      fontSize: 30,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 1,
                      color: onDark,
                    ),
                  ),
                  Text('beginnt in',
                      style: TextStyle(fontSize: 11.5, color: mutedOnDark)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ── KPI row ──────────────────────────────────────────────────────────────
  // Member KPIs (prototype MHome:30-41): "Meine Aufgaben · im Deck" and
  // "Ungelesen · Matrix". No finance on the member home.
  Widget _kpiRow(Color muted, int unread) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Row(
      children: [
        Expanded(
          child: _kpiCard(
            muted,
            label: 'Meine Aufgaben',
            value: _myTasks < 0 ? '—' : '$_myTasks',
            delta: 'im Deck',
            deltaColor: muted,
          ),
        ),
        const SizedBox(width: GremionTokens.s3),
        Expanded(
          child: _kpiCard(
            muted,
            label: 'Ungelesen',
            value: '$unread',
            delta: 'Matrix',
            deltaColor:
                dark ? GremionTokens.accentInkDark : GremionTokens.accentInk,
          ),
        ),
      ],
    );
  }

  Widget _kpiCard(Color muted,
      {required String label,
      required String value,
      required String delta,
      required Color deltaColor}) {
    return Container(
      padding: const EdgeInsets.all(GremionTokens.s4),
      decoration: _cardBox(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 12, color: muted)),
          const SizedBox(height: 6),
          Text(
            value,
            style: TextStyle(
              fontFamily: GremionTokens.fontDisplay,
              fontSize: 24,
              fontWeight: FontWeight.w500,
              color: Theme.of(context).colorScheme.onSurface,
            ),
          ),
          if (delta.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(delta,
                style: TextStyle(
                    fontFamily: GremionTokens.fontMono,
                    fontSize: 10.5,
                    color: deltaColor)),
          ],
        ],
      ),
    );
  }

  // ── Anstehend list ────────────────────────────────────────────────────────
  Widget _upcomingList(Color muted) {
    if (_upcoming.isEmpty) {
      return _emptyCard('Keine anstehenden Termine.', muted);
    }
    final shown = _upcoming.take(4).toList();
    return Container(
      decoration: _cardBox(),
      child: Column(
        children: [
          for (var i = 0; i < shown.length; i++) ...[
            if (i > 0)
              Divider(height: 1, color: Theme.of(context).dividerColor),
            _eventRow(shown[i], muted, i == 0),
          ],
        ],
      ),
    );
  }

  Widget _eventRow(CalendarEvent e, Color muted, bool isFirst) {
    return Padding(
      padding: const EdgeInsets.all(GremionTokens.s3),
      child: Row(
        children: [
          Container(
            width: 44,
            padding: const EdgeInsets.symmetric(vertical: 6),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              borderRadius: GremionTokens.rSm,
              border: Border.all(color: Theme.of(context).dividerColor),
            ),
            child: Column(
              children: [
                Text('${e.start.day}',
                    style: TextStyle(
                        fontFamily: GremionTokens.fontDisplay,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: Theme.of(context).colorScheme.onSurface)),
                Text(_monthAbbr(e.start.month),
                    style: TextStyle(
                        fontFamily: GremionTokens.fontMono,
                        fontSize: 9,
                        color: muted)),
              ],
            ),
          ),
          const SizedBox(width: GremionTokens.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(e.title,
                    style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w500,
                        color: Theme.of(context).colorScheme.onSurface)),
                if (e.location != null && e.location!.isNotEmpty)
                  Text(e.location!,
                      style: TextStyle(fontSize: 11.5, color: muted)),
              ],
            ),
          ),
          if (isFirst)
            _pill('LIVE', GremionTokens.accent, GremionTokens.accentSoft),
        ],
      ),
    );
  }

  // ── Live votes list ─────────────────────────────────────────────────────
  Widget _liveVotesList(Color muted) {
    if (_liveVotes.isEmpty) {
      return _emptyCard('Keine laufenden Abstimmungen.', muted);
    }
    return Column(
      children: [
        for (final v in _liveVotes)
          Container(
            margin: const EdgeInsets.only(bottom: GremionTokens.s2),
            padding: const EdgeInsets.all(GremionTokens.s4),
            decoration: _cardBox(),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(v.title,
                          style: TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w500,
                              color: Theme.of(context).colorScheme.onSurface)),
                    ),
                    _pill('LIVE', GremionTokens.accent, GremionTokens.accentSoft),
                  ],
                ),
                const SizedBox(height: GremionTokens.s2 + 2),
                // Turnout progress bar (mobile.css:338 — .m-progress-bar).
                ClipRRect(
                  borderRadius: const BorderRadius.all(Radius.circular(2)),
                  child: LinearProgressIndicator(
                    value: v.turnout, // null → indeterminate "läuft"
                    minHeight: 3,
                    backgroundColor:
                        Theme.of(context).brightness == Brightness.dark
                            ? GremionTokens.surface2Dark
                            : GremionTokens.surface2,
                    color: GremionTokens.accent,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  v.turnout != null
                      ? 'Beteiligung ${(v.turnout! * 100).round()}%'
                      : 'Beteiligung —',
                  style: TextStyle(
                      fontFamily: GremionTokens.fontMono,
                      fontSize: 10,
                      color: muted),
                ),
              ],
            ),
          ),
      ],
    );
  }

  // ── Shared bits ───────────────────────────────────────────────────────────
  Widget _sectionTitle(String text) => Text(
        text.toUpperCase(),
        style: TextStyle(
          fontFamily: GremionTokens.fontMono,
          fontSize: 10.5,
          letterSpacing: 1.4,
          fontWeight: FontWeight.w500,
          color: Theme.of(context).brightness == Brightness.dark
              ? GremionTokens.inkMutedDark
              : GremionTokens.inkMuted,
        ),
      );

  TextStyle _eyebrow(Color color) => TextStyle(
        fontFamily: GremionTokens.fontMono,
        fontSize: 10.5,
        letterSpacing: 1.4,
        fontWeight: FontWeight.w500,
        color: color,
      );

  BoxDecoration _cardBox() => BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: GremionTokens.rMd,
        border: Border.all(color: Theme.of(context).dividerColor),
      );

  Widget _emptyCard(String text, Color muted) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(GremionTokens.s5),
        decoration: _cardBox(),
        child: Text(text,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, color: muted)),
      );

  Widget _pill(String text, Color fg, Color bg) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: bg, borderRadius: GremionTokens.rXs),
        child: Text(text,
            style: TextStyle(
                fontFamily: GremionTokens.fontMono,
                fontSize: 9.5,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w600,
                color: fg)),
      );

  // ── Formatting helpers ──────────────────────────────────────────────────
  String _greeting() {
    final h = DateTime.now().hour;
    if (h < 11) return 'Guten Morgen';
    if (h < 18) return 'Guten Tag';
    return 'Guten Abend';
  }

  bool _isToday(DateTime d) {
    final n = DateTime.now();
    return d.year == n.year && d.month == n.month && d.day == n.day;
  }

  String _countdown(DateTime target) {
    final diff = target.difference(DateTime.now());
    if (diff.isNegative) return 'läuft';
    if (diff.inDays >= 1) {
      return '${diff.inDays} Tag${diff.inDays == 1 ? '' : 'e'}';
    }
    final h = diff.inHours.toString().padLeft(2, '0');
    final m = (diff.inMinutes % 60).toString().padLeft(2, '0');
    final s = (diff.inSeconds % 60).toString().padLeft(2, '0');
    return '$h:$m:$s';
  }

  /// Sum of unread notifications across joined Matrix rooms — the same source
  /// the tab-bar dot and the chat list use (room.notificationCount). Guarded so
  /// an uninitialised client yields 0.
  int _unreadCount(MatrixService matrix) {
    if (!matrix.isInitialized) return 0;
    try {
      var total = 0;
      for (final room in matrix.client.rooms) {
        total += room.notificationCount;
      }
      return total;
    } catch (_) {
      return 0;
    }
  }

  static const _months = [
    'JAN',
    'FEB',
    'MÄR',
    'APR',
    'MAI',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OKT',
    'NOV',
    'DEZ',
  ];
  String _monthAbbr(int month) => _months[(month - 1).clamp(0, 11)];

  /// Decode a JWT's payload (claims) without verifying the signature — used
  /// only to read display/identity claims for the UI (the token was already
  /// signature-verified by AuthService before it ever reached this screen).
  Map<String, dynamic>? _jwtPayload(String? jwt) {
    if (jwt == null || jwt.isEmpty) return null;
    final parts = jwt.split('.');
    if (parts.length < 2) return null;
    try {
      var payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
      while (payload.length % 4 != 0) {
        payload += '=';
      }
      final decoded = jsonDecode(utf8.decode(base64.decode(payload)));
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  String _firstNameFromIdToken(String? idToken) {
    final map = _jwtPayload(idToken);
    if (map == null) return '';
    final given = map['given_name'] as String?;
    if (given != null && given.isNotEmpty) return given;
    final name = map['name'] as String?;
    if (name != null && name.isNotEmpty) return name.split(' ').first;
    final preferred = map['preferred_username'] as String?;
    if (preferred != null && preferred.isNotEmpty) return preferred;
    return '';
  }

  /// The Keycloak user id (`sub` claim) — board cards store the assignee as
  /// this id, so it's what "Meine Aufgaben" matches against.
  String? _subFromIdToken(String? token) {
    final sub = _jwtPayload(token)?['sub'];
    return sub is String && sub.isNotEmpty ? sub : null;
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(GremionTokens.s4),
              child: Text(message, textAlign: TextAlign.center),
            ),
            TextButton(onPressed: onRetry, child: const Text('Erneut laden')),
          ],
        ),
      );
}
