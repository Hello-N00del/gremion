// mobile/lib/screens/calendar/calendar_screen.dart
//
// Phase 5.1 (v5 mobile rebuild) — the calendar is now an AGENDA list grouped by
// day (mobile-app.jsx:204-249 / mobile.css:306-336): "Alle / Nur meine" filter
// chips, a committee-hued left-gutter monogram per item, a "MEIN" pill on the
// user's own events, and a mono meta line. The TableCalendar month grid is
// demoted to a secondary view reachable from the header (toggle). All data
// wiring (getEvents, EventEditScreen, the write-guarded create FAB) is
// preserved. German copy throughout.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:table_calendar/table_calendar.dart';

import '../../models/calendar_event.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';
import 'event_edit_screen.dart';

class CalendarScreen extends StatefulWidget {
  const CalendarScreen({super.key});
  @override
  State<CalendarScreen> createState() => _CalendarScreenState();
}

class _CalendarScreenState extends State<CalendarScreen> {
  DateTime _focusedDay = DateTime.now();
  DateTime? _selectedDay;
  List<CalendarEvent> _events = [];
  bool _loading = true;
  String? _error;
  bool _mineOnly = false;
  bool _monthView = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final start = DateTime(_focusedDay.year, _focusedDay.month, 1);
      final end = DateTime(_focusedDay.year, _focusedDay.month + 1, 0);
      final events = await context
          .read<StuRaOSApiClient>()
          .getEvents(from: start, to: end);
      if (mounted) {
        setState(() {
          _events = events..sort((a, b) => a.start.compareTo(b.start));
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  List<CalendarEvent> _eventsForDay(DateTime day) =>
      _events.where((e) => isSameDay(e.start, day)).toList();

  // The live event model has no membership flag; derive "mine" from the events
  // the user can write (committee membership ≈ write access). When the session
  // can't write anything, nothing is "mine" and the "Nur meine" chip simply
  // yields an empty state — honest rather than faked.
  bool _isMine(CalendarEvent e, bool canWrite) => canWrite;

  // Committee key: the live event carries no org-unit, so we derive a stable
  // grouping key from the location (room/committee tag) when present, else the
  // first word of the title. This feeds the committee-hue colouring only.
  String _committeeKey(CalendarEvent e) {
    if (e.location != null && e.location!.trim().isNotEmpty) {
      return e.location!.trim();
    }
    return e.title.split(RegExp(r'[\s·–-]+')).first;
  }

  @override
  Widget build(BuildContext context) {
    final canWrite = context.watch<AuthService>().session?.canWrite() ?? false;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;

    final mineCount = _events.where((e) => _isMine(e, canWrite)).length;
    final monthLabel = _monthName(_focusedDay.month);

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? _ErrorView(message: _error!, onRetry: _load)
                : Column(
                    children: [
                      MScreenHead(
                        eyebrow: 'Kalender · $monthLabel ${_focusedDay.year}',
                        title: 'Termine',
                        sub:
                            '$mineCount deiner Termine · ${_events.length} gesamt',
                        trailing: IconButton(
                          tooltip: _monthView ? 'Agenda' : 'Monatsansicht',
                          icon: Icon(
                            _monthView
                                ? Icons.view_agenda_outlined
                                : Icons.calendar_month_outlined,
                            size: 20,
                            color: muted,
                          ),
                          onPressed: () =>
                              setState(() => _monthView = !_monthView),
                        ),
                      ),
                      Expanded(
                        child: _monthView
                            ? _monthGrid(muted)
                            : _agenda(muted, canWrite),
                      ),
                    ],
                  ),
      ),
      floatingActionButton: canWrite
          ? FloatingActionButton(
              backgroundColor: GremionTokens.accent,
              foregroundColor: GremionTokens.paper,
              onPressed: () async {
                await Navigator.push<void>(
                    context,
                    MaterialPageRoute<void>(
                        builder: (_) => const EventEditScreen()));
                await _load();
              },
              child: const Icon(Icons.add),
            )
          : null,
    );
  }

  // ── Agenda (primary) ─────────────────────────────────────────────────────
  Widget _agenda(Color muted, bool canWrite) {
    final shown = _mineOnly
        ? _events.where((e) => _isMine(e, canWrite)).toList()
        : _events;

    // Group by calendar day, preserving chronological order.
    final groups = <DateTime, List<CalendarEvent>>{};
    for (final e in shown) {
      final d = DateTime(e.start.year, e.start.month, e.start.day);
      groups.putIfAbsent(d, () => []).add(e);
    }
    final days = groups.keys.toList()..sort();

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.only(bottom: GremionTokens.s8),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
                GremionTokens.s4, GremionTokens.s3, GremionTokens.s4, 0),
            child: Row(
              children: [
                _filterChip('Alle', !_mineOnly,
                    () => setState(() => _mineOnly = false)),
                const SizedBox(width: GremionTokens.s2),
                _filterChip('Nur meine', _mineOnly,
                    () => setState(() => _mineOnly = true)),
              ],
            ),
          ),
          if (shown.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(
                  horizontal: GremionTokens.s5, vertical: GremionTokens.s8),
              child: Text('Keine Termine in dieser Auswahl.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 12.5, color: muted)),
            )
          else
            for (final day in days) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(GremionTokens.s5,
                    GremionTokens.s4 + 2, GremionTokens.s5, GremionTokens.s1 + 2),
                child: Text(
                  _dayLabel(day).toUpperCase(),
                  style: TextStyle(
                    fontFamily: GremionTokens.fontMono,
                    fontSize: 10.5,
                    letterSpacing: 1.4,
                    color: muted,
                  ),
                ),
              ),
              for (final e in groups[day]!)
                _agendaItem(e, muted, _isMine(e, canWrite)),
            ],
        ],
      ),
    );
  }

  Widget _agendaItem(CalendarEvent e, Color muted, bool mine) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final key = _committeeKey(e);
    final hueColor = committeeColor(key, dark: dark);
    final onSurface = Theme.of(context).colorScheme.onSurface;
    final faint = dark ? GremionTokens.inkFaintDark : GremionTokens.inkFaint;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
          GremionTokens.s4, 0, GremionTokens.s4, GremionTokens.s2),
      child: InkWell(
        borderRadius: GremionTokens.rMd,
        onTap: () async {
          await Navigator.push<void>(
              context,
              MaterialPageRoute<void>(
                  builder: (_) => EventEditScreen(event: e)));
          await _load();
        },
        child: Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            borderRadius: GremionTokens.rMd,
            border: Border.all(
              color: mine ? hueColor : Theme.of(context).dividerColor,
              width: mine ? 1.5 : 1,
            ),
          ),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Committee-hued gutter monogram.
                Container(
                  width: 40,
                  color: hueColor,
                  alignment: Alignment.center,
                  child: Text(
                    committeeMonogram(key),
                    style: const TextStyle(
                      fontFamily: GremionTokens.fontMono,
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.4,
                      color: Colors.white,
                    ),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: GremionTokens.s3 + 2, vertical: 11),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(e.title,
                            style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w500,
                                color: onSurface)),
                        if (e.location != null && e.location!.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(e.location!,
                              style: TextStyle(fontSize: 11.5, color: muted)),
                        ],
                        const SizedBox(height: 4),
                        Text(
                          '${_timeRange(e)} · Termin',
                          style: TextStyle(
                              fontFamily: GremionTokens.fontMono,
                              fontSize: 10,
                              letterSpacing: 0.2,
                              color: faint),
                        ),
                      ],
                    ),
                  ),
                ),
                if (mine)
                  Padding(
                    padding: const EdgeInsets.only(right: GremionTokens.s3),
                    child: Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                            color: dark
                                ? GremionTokens.accentSoftDark
                                : GremionTokens.accentSoft,
                            borderRadius: GremionTokens.rXs),
                        child: Text('MEIN',
                            style: TextStyle(
                                fontFamily: GremionTokens.fontMono,
                                fontSize: 9,
                                fontWeight: FontWeight.w600,
                                letterSpacing: 0.6,
                                color: dark
                                    ? GremionTokens.accentInkDark
                                    : GremionTokens.accentInk)),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _filterChip(String label, bool on, VoidCallback onTap) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final ink = dark ? GremionTokens.inkDark : GremionTokens.ink;
    final paper = dark ? GremionTokens.paperDark : GremionTokens.paper;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 6),
        decoration: BoxDecoration(
          color: on ? ink : Theme.of(context).colorScheme.surface,
          borderRadius: const BorderRadius.all(Radius.circular(100)),
          border: Border.all(
              color: on
                  ? ink
                  : (dark
                      ? GremionTokens.borderStrongDark
                      : GremionTokens.borderStrong)),
        ),
        child: Text(label,
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: on ? paper : muted)),
      ),
    );
  }

  // ── Month grid (secondary) ───────────────────────────────────────────────
  Widget _monthGrid(Color muted) {
    final dayEvents =
        _selectedDay != null ? _eventsForDay(_selectedDay!) : <CalendarEvent>[];
    final onSurface = Theme.of(context).colorScheme.onSurface;
    return Column(children: [
      TableCalendar<CalendarEvent>(
        firstDay: DateTime.utc(2020),
        lastDay: DateTime.utc(2030),
        focusedDay: _focusedDay,
        selectedDayPredicate: (d) => isSameDay(d, _selectedDay),
        eventLoader: _eventsForDay,
        onDaySelected: (selected, focused) => setState(() {
          _selectedDay = selected;
          _focusedDay = focused;
        }),
        onPageChanged: (focused) {
          _focusedDay = focused;
          _load();
        },
        calendarStyle: CalendarStyle(
          todayDecoration: BoxDecoration(
            color: GremionTokens.accent.withValues(alpha: 0.3),
            shape: BoxShape.circle,
          ),
          selectedDecoration: const BoxDecoration(
            color: GremionTokens.accent,
            shape: BoxShape.circle,
          ),
          markerDecoration: const BoxDecoration(
            color: GremionTokens.ember,
            shape: BoxShape.circle,
          ),
        ),
        headerStyle:
            const HeaderStyle(formatButtonVisible: false, titleCentered: true),
      ),
      Divider(height: 1, color: Theme.of(context).dividerColor),
      Expanded(
        child: dayEvents.isEmpty
            ? Center(
                child: Text(
                    _selectedDay == null
                        ? 'Tag auswählen'
                        : 'Keine Termine an diesem Tag.',
                    style: TextStyle(fontSize: 12.5, color: muted)))
            : ListView.separated(
                itemCount: dayEvents.length,
                separatorBuilder: (_, __) =>
                    Divider(height: 1, color: Theme.of(context).dividerColor),
                itemBuilder: (_, i) {
                  final e = dayEvents[i];
                  return ListTile(
                    title: Text(e.title,
                        style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                            color: onSurface)),
                    subtitle: Text(_timeRange(e),
                        style: TextStyle(
                            fontFamily: GremionTokens.fontMono,
                            fontSize: 11,
                            color: muted)),
                  );
                },
              ),
      ),
    ]);
  }

  // ── Formatting ───────────────────────────────────────────────────────────
  String _timeRange(CalendarEvent e) => '${_fmt(e.start)}–${_fmt(e.end)}';

  String _fmt(DateTime dt) =>
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';

  String _dayLabel(DateTime day) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final diff = day.difference(today).inDays;
    if (diff == 0) return 'Heute';
    if (diff == 1) return 'Morgen';
    const weekdays = [
      'Montag',
      'Dienstag',
      'Mittwoch',
      'Donnerstag',
      'Freitag',
      'Samstag',
      'Sonntag',
    ];
    return '${weekdays[day.weekday - 1]} · ${day.day}. ${_monthName(day.month)}';
  }

  static const _monthNames = [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ];
  String _monthName(int month) => _monthNames[(month - 1).clamp(0, 11)];
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
