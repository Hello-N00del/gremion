// mobile/lib/screens/deck/deck_screen.dart
//
// Part G (Design v8) — the Deck/Aufgaben tab. Ports the handoff `MDeck`
// (design_files/mobile/mobile-app.jsx:253-298 / mobile.css:358-416) onto
// Flutter + GremionTokens: a horizontally-scrolling board switcher (one chip per
// Gremium/Referat board), then each stack (column) rendered as a labelled
// section of cards. A card carries a hued label pill, title, optional
// description, and a foot with the assignee avatar + due date.
//
// Data comes from the EXISTING gremion-ui board routes (no new backend):
//   getBoards()       → GET /api/board
//   getBoardDeck(id)  → GET /api/board/[id]  (board + stacks + cards)
// The first board is selected on load; switching refetches that board's deck.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/deck_card.dart';
import '../../services/api_client.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';

class DeckScreen extends StatefulWidget {
  const DeckScreen({super.key});
  @override
  State<DeckScreen> createState() => _DeckScreenState();
}

class _DeckScreenState extends State<DeckScreen> {
  List<Board> _boards = [];
  String? _selectedBoardId;
  Deck? _deck;
  bool _loadingBoards = true;
  bool _loadingDeck = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadBoards();
  }

  Future<void> _loadBoards() async {
    setState(() {
      _loadingBoards = true;
      _error = null;
    });
    try {
      final boards = await context.read<StuRaOSApiClient>().getBoards();
      if (!mounted) return;
      setState(() {
        _boards = boards;
        _loadingBoards = false;
      });
      if (boards.isNotEmpty) {
        await _selectBoard(boards.first.id);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loadingBoards = false;
      });
    }
  }

  Future<void> _selectBoard(String boardId) async {
    setState(() {
      _selectedBoardId = boardId;
      _loadingDeck = true;
      _error = null;
    });
    try {
      final deck = await context.read<StuRaOSApiClient>().getBoardDeck(boardId);
      if (!mounted) return;
      setState(() {
        _deck = deck;
        _loadingDeck = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loadingDeck = false;
      });
    }
  }

  Future<void> _refresh() async {
    if (_selectedBoardId != null) {
      await _selectBoard(_selectedBoardId!);
    } else {
      await _loadBoards();
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final deck = _deck;
    final cardCount = deck?.cards.length ?? 0;
    final stackCount = deck?.stacks.length ?? 0;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            MScreenHead(
              eyebrow: 'Nextcloud Deck',
              title: 'Aufgaben',
              sub: '$cardCount Karten · $stackCount Spalten',
            ),
            Expanded(child: _body(muted)),
          ],
        ),
      ),
    );
  }

  Widget _body(Color muted) {
    if (_loadingBoards) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _deck == null) {
      return _ErrorView(message: _error!, onRetry: _refresh);
    }
    if (_boards.isEmpty) {
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(
                  horizontal: GremionTokens.s5, vertical: GremionTokens.s8),
              child: Text('Keine Boards verfügbar.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 12.5, color: muted)),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.only(bottom: GremionTokens.s8),
        children: [
          _boardSwitch(muted),
          if (_loadingDeck)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: GremionTokens.s8),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_deck != null)
            ..._stacks(muted),
        ],
      ),
    );
  }

  // ── Board switcher (horizontal chips) ────────────────────────────────────
  Widget _boardSwitch(Color muted) {
    return SizedBox(
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(
            GremionTokens.s4, GremionTokens.s3, GremionTokens.s4, GremionTokens.s1),
        itemCount: _boards.length,
        separatorBuilder: (_, __) => const SizedBox(width: GremionTokens.s2),
        itemBuilder: (_, i) {
          final b = _boards[i];
          return _boardChip(
              b.name, b.id == _selectedBoardId, () => _selectBoard(b.id));
        },
      ),
    );
  }

  Widget _boardChip(String label, bool on, VoidCallback onTap) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final onSoft = dark ? GremionTokens.accentSoftDark : GremionTokens.accentSoft;
    final onInk = dark ? GremionTokens.accentInkDark : GremionTokens.accentInk;
    final ink2 = dark ? GremionTokens.ink2Dark : GremionTokens.ink2;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        alignment: Alignment.center,
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
        decoration: BoxDecoration(
          color: on ? onSoft : Theme.of(context).colorScheme.surface,
          borderRadius: const BorderRadius.all(Radius.circular(100)),
          border: Border.all(
              color: on ? Colors.transparent : Theme.of(context).dividerColor),
        ),
        child: Text(label,
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: on ? onInk : ink2)),
      ),
    );
  }

  // ── Stacks (columns) + cards ─────────────────────────────────────────────
  List<Widget> _stacks(Color muted) {
    final deck = _deck!;
    if (deck.stacks.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(
              horizontal: GremionTokens.s5, vertical: GremionTokens.s8),
          child: Text('Dieses Board hat keine Spalten.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: muted)),
        ),
      ];
    }
    return [
      for (final stack in deck.stacks) ..._stackSection(stack, deck, muted),
    ];
  }

  List<Widget> _stackSection(DeckStack stack, Deck deck, Color muted) {
    final cards = deck.cardsIn(stack.id);
    return [
      // Stack head: mono uppercase name + count chip.
      Padding(
        padding: const EdgeInsets.fromLTRB(
            GremionTokens.s5, GremionTokens.s3, GremionTokens.s5, 6),
        child: Row(
          children: [
            Text(
              stack.name.toUpperCase(),
              style: TextStyle(
                fontFamily: GremionTokens.fontMono,
                fontSize: 10.5,
                letterSpacing: 1.4,
                fontWeight: FontWeight.w600,
                color: muted,
              ),
            ),
            const SizedBox(width: GremionTokens.s2),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
              decoration: BoxDecoration(
                color: Theme.of(context).brightness == Brightness.dark
                    ? GremionTokens.surface2Dark
                    : GremionTokens.surface2,
                borderRadius: const BorderRadius.all(Radius.circular(100)),
              ),
              child: Text('${cards.length}',
                  style: TextStyle(
                      fontFamily: GremionTokens.fontMono,
                      fontSize: 10,
                      color: Theme.of(context).brightness == Brightness.dark
                          ? GremionTokens.inkFaintDark
                          : GremionTokens.inkFaint)),
            ),
          ],
        ),
      ),
      if (cards.isEmpty)
        _emptyStack(muted)
      else
        for (final c in cards) _deckCard(c, muted),
    ];
  }

  Widget _emptyStack(Color muted) => Container(
        margin: const EdgeInsets.fromLTRB(
            GremionTokens.s4, 0, GremionTokens.s4, GremionTokens.s2),
        padding: const EdgeInsets.all(GremionTokens.s4),
        decoration: BoxDecoration(
          borderRadius: GremionTokens.rMd,
          border: Border.all(color: Theme.of(context).dividerColor),
        ),
        child: Text('Keine Karten',
            textAlign: TextAlign.center,
            style: TextStyle(
                fontSize: 11.5,
                color: Theme.of(context).brightness == Brightness.dark
                    ? GremionTokens.inkFaintDark
                    : GremionTokens.inkFaint)),
      );

  Widget _deckCard(DeckCard c, Color muted) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    final ink2 = dark ? GremionTokens.ink2Dark : GremionTokens.ink2;
    return Container(
      margin: const EdgeInsets.fromLTRB(
          GremionTokens.s4, 0, GremionTokens.s4, GremionTokens.s2),
      padding: const EdgeInsets.all(GremionTokens.s3 + 1),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: GremionTokens.rMd,
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (c.label != null && c.label!.trim().isNotEmpty) ...[
            _labelPill(c.label!.trim(), dark),
            const SizedBox(height: 7),
          ],
          Text(
            c.title,
            style: TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w500,
                height: 1.3,
                color: onSurface),
          ),
          if (c.description != null && c.description!.trim().isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(
              c.description!.trim(),
              style: TextStyle(fontSize: 11.5, height: 1.4, color: muted),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              // Assignee. The board carries only the assignee's raw Keycloak
              // UUID and mobile has no member directory to resolve it to a
              // name, so we never render the id as text. When assigned, show
              // only the avatar monogram (a stable, non-identifying shape
              // derived from the id); when unassigned, show the "Niemand"
              // placeholder.
              Flexible(
                child: _hasAssignee(c.assigneeKeycloakId)
                    ? Container(
                        width: 20,
                        height: 20,
                        decoration: BoxDecoration(
                          color: dark
                              ? GremionTokens.accentSoftDark
                              : GremionTokens.accentSoft,
                          shape: BoxShape.circle,
                        ),
                        alignment: Alignment.center,
                        child: Text(
                          _assigneeInitials(c.assigneeKeycloakId),
                          style: TextStyle(
                              fontFamily: GremionTokens.fontMono,
                              fontSize: 9,
                              fontWeight: FontWeight.w600,
                              color: dark
                                  ? GremionTokens.accentInkDark
                                  : GremionTokens.accentInk),
                        ),
                      )
                    : Text(
                        'Niemand',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, color: ink2),
                      ),
              ),
              if (c.dueDate != null && c.dueDate!.isNotEmpty) ...[
                const SizedBox(width: GremionTokens.s2),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color:
                        dark ? GremionTokens.surface2Dark : GremionTokens.surface2,
                    borderRadius: GremionTokens.rSm,
                  ),
                  child: Text(
                    _formatDue(c.dueDate!),
                    style: TextStyle(
                        fontFamily: GremionTokens.fontMono,
                        fontSize: 10.5,
                        color: muted),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  // Label pill — hue derived from the label string (the backend Card.label is
  // a bare string with no colour), mirroring the calendar's committee-hue
  // approach. Prototype: bg oklch(93% .04 hue) / fg oklch(40% .12 hue) light.
  Widget _labelPill(String label, bool dark) {
    final hue = committeeHue(label).toDouble();
    final bg = dark ? _oklch(0.28, 0.06, hue) : _oklch(0.93, 0.04, hue);
    final fg = dark ? _oklch(0.82, 0.11, hue) : _oklch(0.40, 0.12, hue);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
          color: bg,
          borderRadius: const BorderRadius.all(Radius.circular(100))),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
            fontFamily: GremionTokens.fontMono,
            fontSize: 9,
            letterSpacing: 0.6,
            fontWeight: FontWeight.w500,
            color: fg),
      ),
    );
  }

  // ── Assignee helpers ──────────────────────────────────────────────────────
  // The board cards carry only the assignee's raw Keycloak UUID; mobile has no
  // member directory, so we never surface the id as a human label (it would
  // leak an internal id and read as gibberish). We only use it to decide
  // whether a card is assigned and to derive a stable, non-identifying avatar
  // monogram.
  bool _hasAssignee(String? keycloakId) =>
      keycloakId != null && keycloakId.trim().isNotEmpty;

  // Two-char monogram used purely for the avatar shape — never shown as text.
  String _assigneeInitials(String? keycloakId) {
    final k = (keycloakId ?? '').trim();
    if (k.isEmpty) return '··';
    final parts =
        k.split(RegExp(r'[\s._@-]+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '··';
    if (parts.length == 1) {
      final w = parts.first;
      return (w.length >= 2 ? w.substring(0, 2) : w).toUpperCase();
    }
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // due_date is a date-only ISO string ("2026-04-23"). Render "23. Apr".
  String _formatDue(String iso) {
    final d = DateTime.tryParse(iso);
    if (d == null) return iso;
    const months = [
      'Jan',
      'Feb',
      'Mär',
      'Apr',
      'Mai',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Okt',
      'Nov',
      'Dez',
    ];
    return '${d.day}. ${months[(d.month - 1).clamp(0, 11)]}';
  }
}

// OKLCH → sRGB Color. Duplicated locally (the committee_hue.dart variant is
// private) at the prototype's deck-label lightness/chroma. L in [0,1].
Color _oklch(double l, double c, double hDeg) {
  final h = hDeg * math.pi / 180.0;
  final aa = c * math.cos(h);
  final bb = c * math.sin(h);

  final lDash = l + 0.3963377774 * aa + 0.2158037573 * bb;
  final mDash = l - 0.1055613458 * aa - 0.0638541728 * bb;
  final sDash = l - 0.0894841775 * aa - 1.2914855480 * bb;

  final lc = lDash * lDash * lDash;
  final mc = mDash * mDash * mDash;
  final sc = sDash * sDash * sDash;

  final r = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  final g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  final b = -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc;

  int toByte(double linear) {
    final v = linear <= 0.0031308
        ? 12.92 * linear
        : 1.055 * math.pow(linear, 1 / 2.4) - 0.055;
    return (v.clamp(0.0, 1.0) * 255).round();
  }

  return Color.fromARGB(255, toByte(r), toByte(g), toByte(b));
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
