// mobile/lib/screens/elections/elections_screen.dart
//
// Phase 5.3 (v5 mobile rebuild) — Wahlen & Abstimmungen restyled to the
// institutional v5 system (mobile-app.jsx:113-149 / mobile.css:192-216):
// a kind badge (Helios E2E shield / Umfrage), an accent-fill radio "Stimme
// abgeben" sheet with per-option %, and a "Beteiligung" mono box. The real
// Helios WebView ballot, the host-allowlist navigation guard
// (`isHeliosNavigationAllowed`) and the Nextcloud-Polls backend are all
// preserved. German copy throughout.
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:provider/provider.dart';
import '../../app.dart' show heliosBaseUrl;
import '../../models/election.dart';
import '../../models/poll.dart';
import '../../models/user_session.dart';
import '../../services/api_client.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';
import '../../widgets/role_guard.dart';

/// G-089: pure URL-policy predicate for the Helios ballot WebView.
///
/// Returns `true` (= ALLOW) only when [url] is an HTTPS URL whose host
/// matches the host of [allowedBaseUrl]. Any other input — including null,
/// a `data:` / `javascript:` / `file:` scheme, or a different host — is
/// CANCELled. Extracted as a top-level function so the policy is directly
/// unit-testable without standing up an `InAppWebView` widget.
bool isHeliosNavigationAllowed(Uri? url, String allowedBaseUrl) {
  if (url == null || url.scheme != 'https') return false;
  final allowed = Uri.tryParse(allowedBaseUrl);
  if (allowed == null || url.host != allowed.host) return false;
  return true;
}

class ElectionsScreen extends StatefulWidget {
  const ElectionsScreen({super.key});
  @override
  State<ElectionsScreen> createState() => _ElectionsScreenState();
}

class _ElectionsScreenState extends State<ElectionsScreen> {
  List<Election> _elections = [];
  bool _loading = true;
  String? _error;

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
      final elections = await context.read<StuRaOSApiClient>().getElections();
      if (mounted) {
        setState(() {
          _elections = elections;
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

  void _openBallot(Election election) {
    final ballotUrl = '$heliosBaseUrl/elections/${election.id}/vote';
    Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
            builder: (_) =>
                _HeliosBallotScreen(election: election, ballotUrl: ballotUrl)));
  }

  Future<void> _openPoll(Election election) async {
    final api = context.read<StuRaOSApiClient>();
    Poll poll;
    try {
      poll = await api.getPollDetail(election.id);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Umfrage konnte nicht geladen werden: $e')));
      }
      return;
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _PollVoteSheet(poll: poll, api: api),
    );
    _load();
  }

  Future<void> _onCreateTap() async {
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('Erstellen'),
        children: [
          SimpleDialogOption(
            onPressed: () => Navigator.pop(ctx, 'poll'),
            child: const ListTile(
              leading: Icon(Icons.poll_outlined),
              title: Text('Neue Umfrage'),
              subtitle: Text('Nextcloud-Polls-Abstimmung'),
            ),
          ),
          SimpleDialogOption(
            onPressed: () => Navigator.pop(ctx, 'helios'),
            child: const ListTile(
              leading: Icon(Icons.how_to_vote_outlined),
              title: Text('Neue Helios-Wahl'),
              subtitle: Text('Helios-Verwaltung öffnen'),
            ),
          ),
        ],
      ),
    );
    if (choice == 'poll') await _createPoll();
    if (choice == 'helios') _openHeliosAdmin();
  }

  void _openHeliosAdmin() {
    Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => const _HeliosBallotScreen(
            election: Election(
                id: '',
                title: 'Helios-Verwaltung',
                status: ElectionStatus.active,
                type: ElectionType.helios),
            ballotUrl: '$heliosBaseUrl/elections/new',
          ),
        ));
  }

  Future<void> _createPoll() async {
    final result = await showDialog<Map<String, dynamic>>(
        context: context, builder: (_) => const _CreatePollDialog());
    if (result == null || !mounted) return;
    try {
      await context.read<StuRaOSApiClient>().createPoll(
            result['title'] as String,
            List<String>.from(result['options'] as List),
            result['deadline'] as DateTime,
            '',
          );
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text('Umfrage konnte nicht erstellt werden: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final liveCount =
        _elections.where((e) => e.status == ElectionStatus.active).length;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            MScreenHead(
              eyebrow: 'Abstimmungen · Helios E2E + Polls',
              title: 'Wahlen',
              sub: '${_elections.length} gesamt · $liveCount laufend',
            ),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? _ErrorView(message: _error!, onRetry: _load)
                      : _elections.isEmpty
                          ? Center(
                              child: Text('Keine Wahlen oder Umfragen.',
                                  style: TextStyle(fontSize: 13, color: muted)))
                          : RefreshIndicator(
                              onRefresh: _load,
                              child: ListView.builder(
                                padding: const EdgeInsets.fromLTRB(
                                    GremionTokens.s4,
                                    GremionTokens.s3,
                                    GremionTokens.s4,
                                    GremionTokens.s8),
                                itemCount: _elections.length,
                                itemBuilder: (_, i) =>
                                    _electionCard(_elections[i], dark, muted),
                              ),
                            ),
            ),
          ],
        ),
      ),
      floatingActionButton: RoleGuard(
        minRole: StuRaRole.councilAdmin,
        child: FloatingActionButton(
          backgroundColor: GremionTokens.accent,
          foregroundColor: GremionTokens.paper,
          onPressed: _onCreateTap,
          child: const Icon(Icons.add),
        ),
      ),
    );
  }

  Widget _electionCard(Election e, bool dark, Color muted) {
    final isPoll = e.type == ElectionType.poll;
    final isActive = e.status == ElectionStatus.active;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    return Container(
      margin: const EdgeInsets.only(bottom: GremionTokens.s2),
      padding: const EdgeInsets.all(GremionTokens.s4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: GremionTokens.rMd,
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _kindBadge(isPoll, dark),
              const Spacer(),
              if (isActive) _livePill(dark),
            ],
          ),
          const SizedBox(height: GremionTokens.s3),
          Text(e.title,
              style: TextStyle(
                  fontFamily: GremionTokens.fontDisplay,
                  fontSize: 16,
                  fontWeight: FontWeight.w500,
                  height: 1.2,
                  color: onSurface)),
          const SizedBox(height: 4),
          Text(
            isPoll
                ? (isActive ? 'Geöffnet zur Abstimmung' : 'Geschlossen')
                : _statusLabel(e.status),
            style: TextStyle(fontSize: 12, color: muted),
          ),
          if (isActive) ...[
            const SizedBox(height: GremionTokens.s3),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: isPoll ? () => _openPoll(e) : () => _openBallot(e),
                style: ElevatedButton.styleFrom(
                  backgroundColor: dark ? GremionTokens.inkDark : GremionTokens.ink,
                  foregroundColor:
                      dark ? GremionTokens.paperDark : GremionTokens.paper,
                  elevation: 0,
                  padding: const EdgeInsets.symmetric(vertical: 13),
                  shape: const RoundedRectangleBorder(
                      borderRadius: GremionTokens.rSm),
                  textStyle: const TextStyle(
                      fontFamily: GremionTokens.fontBody,
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600),
                ),
                child: Text(isPoll ? 'Stimme abgeben' : 'Zum Wahlschein'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _kindBadge(bool isPoll, bool dark) {
    final fg = isPoll
        ? (dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted)
        : (dark ? GremionTokens.pineInkDark : GremionTokens.pineInk);
    final bg = isPoll
        ? (dark ? GremionTokens.surface3Dark : GremionTokens.surface2)
        : (dark ? GremionTokens.pineSoftDark : GremionTokens.pineSoft);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: GremionTokens.rXs),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(isPoll ? Icons.poll_outlined : Icons.verified_user_outlined,
              size: 11, color: fg),
          const SizedBox(width: 4),
          Text(isPoll ? 'UMFRAGE' : 'HELIOS · E2E',
              style: TextStyle(
                  fontFamily: GremionTokens.fontMono,
                  fontSize: 9,
                  letterSpacing: 0.6,
                  fontWeight: FontWeight.w600,
                  color: fg)),
        ],
      ),
    );
  }

  Widget _livePill(bool dark) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
            color: dark ? GremionTokens.accentSoftDark : GremionTokens.accentSoft,
            borderRadius: GremionTokens.rXs),
        child: Text('LIVE',
            style: TextStyle(
                fontFamily: GremionTokens.fontMono,
                fontSize: 9,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w600,
                color:
                    dark ? GremionTokens.accentInkDark : GremionTokens.accentInk)),
      );

  String _statusLabel(ElectionStatus s) => switch (s) {
        ElectionStatus.active => 'Abstimmung geöffnet',
        ElectionStatus.closed => 'Geschlossen',
        ElectionStatus.pending => 'Demnächst',
      };
}

class _PollVoteSheet extends StatefulWidget {
  const _PollVoteSheet({required this.poll, required this.api});
  final Poll poll;
  final StuRaOSApiClient api;

  @override
  State<_PollVoteSheet> createState() => _PollVoteSheetState();
}

class _PollVoteSheetState extends State<_PollVoteSheet> {
  bool _voting = false;
  bool _voted = false;
  int? _selected;

  @override
  void initState() {
    super.initState();
    _voted = widget.poll.voted;
  }

  Future<void> _submit() async {
    if (_voting || _voted || _selected == null) return;
    final option = widget.poll.options[_selected!];
    setState(() => _voting = true);
    try {
      await widget.api.votePoll(widget.poll.id, option.id);
      setState(() => _voted = true);
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Stimme gespeichert.')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Abstimmung fehlgeschlagen: $e')));
      }
    } finally {
      if (mounted) setState(() => _voting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final ink = dark ? GremionTokens.inkDark : GremionTokens.ink;
    final paper = dark ? GremionTokens.paperDark : GremionTokens.paper;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    final poll = widget.poll;
    final totalVotes = poll.options.fold(0, (s, o) => s + o.votes);

    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      expand: false,
      builder: (_, controller) => Container(
        decoration: BoxDecoration(
          color: Theme.of(context).scaffoldBackgroundColor,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: GremionTokens.s2),
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                    color: Theme.of(context).dividerColor,
                    borderRadius: const BorderRadius.all(Radius.circular(2))),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(GremionTokens.s5, GremionTokens.s4,
                  GremionTokens.s5, GremionTokens.s2),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('UMFRAGE · EINFACHE MEHRHEIT',
                      style: TextStyle(
                          fontFamily: GremionTokens.fontMono,
                          fontSize: 10,
                          letterSpacing: 1.4,
                          color: muted)),
                  const SizedBox(height: 4),
                  Text(poll.title,
                      style: TextStyle(
                          fontFamily: GremionTokens.fontDisplay,
                          fontSize: 21,
                          fontWeight: FontWeight.w500,
                          height: 1.15,
                          color: onSurface)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                  GremionTokens.s4, 6, GremionTokens.s4, 4),
              child: Text('DEINE STIMME',
                  style: TextStyle(
                      fontFamily: GremionTokens.fontMono,
                      fontSize: 10.5,
                      letterSpacing: 1.4,
                      color: muted)),
            ),
            Expanded(
              child: poll.options.isEmpty
                  ? Center(
                      child: Text('Keine Optionen vorhanden.',
                          style: TextStyle(fontSize: 13, color: muted)))
                  : ListView(
                      controller: controller,
                      padding: const EdgeInsets.only(bottom: GremionTokens.s4),
                      children: [
                        for (var i = 0; i < poll.options.length; i++)
                          _voteOption(poll.options[i], i, totalVotes, dark,
                              muted, onSurface),
                        // "Beteiligung" mono box.
                        Container(
                          margin: const EdgeInsets.fromLTRB(GremionTokens.s4,
                              GremionTokens.s3, GremionTokens.s4, 0),
                          padding: const EdgeInsets.all(GremionTokens.s4),
                          decoration: BoxDecoration(
                            color: dark
                                ? GremionTokens.surface2Dark
                                : GremionTokens.surface2,
                            borderRadius: GremionTokens.rMd,
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('BETEILIGUNG',
                                  style: TextStyle(
                                      fontFamily: GremionTokens.fontMono,
                                      fontSize: 10,
                                      letterSpacing: 1.4,
                                      color: onSurface)),
                              const SizedBox(height: 4),
                              Text(
                                '$totalVotes Stimmen abgegeben',
                                style: TextStyle(
                                    fontFamily: GremionTokens.fontMono,
                                    fontSize: 11.5,
                                    height: 1.5,
                                    color: muted),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
            ),
            // "Stimme abgeben" button.
            Padding(
              padding: EdgeInsets.fromLTRB(
                  GremionTokens.s4,
                  GremionTokens.s2,
                  GremionTokens.s4,
                  GremionTokens.s4 + MediaQuery.of(context).padding.bottom),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed:
                      _voted || _voting || _selected == null ? null : _submit,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: ink,
                    foregroundColor: paper,
                    disabledBackgroundColor:
                        dark ? GremionTokens.surface3Dark : GremionTokens.surface3,
                    elevation: 0,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: const RoundedRectangleBorder(
                        borderRadius: GremionTokens.rMd),
                    textStyle: const TextStyle(
                        fontFamily: GremionTokens.fontBody,
                        fontSize: 14,
                        fontWeight: FontWeight.w600),
                  ),
                  child: _voting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(_voted ? 'Stimme abgegeben' : 'Stimme abgeben'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _voteOption(
      PollOption o, int i, int total, bool dark, Color muted, Color onSurface) {
    final sel = _selected == i;
    final pct = total > 0 ? (o.votes / total * 100).round() : 0;
    return GestureDetector(
      onTap: _voted ? null : () => setState(() => _selected = i),
      child: Container(
        margin: const EdgeInsets.fromLTRB(
            GremionTokens.s4, 0, GremionTokens.s4, GremionTokens.s2 + 2),
        padding: const EdgeInsets.symmetric(
            horizontal: GremionTokens.s4, vertical: GremionTokens.s4),
        decoration: BoxDecoration(
          color: sel
              ? (dark ? GremionTokens.accentFaintDark : GremionTokens.accentFaint)
              : Theme.of(context).colorScheme.surface,
          borderRadius: GremionTokens.rMd,
          border: Border.all(
            color: sel
                ? (dark ? GremionTokens.accentDark : GremionTokens.accent)
                : Theme.of(context).dividerColor,
          ),
        ),
        child: Row(
          children: [
            // Accent-fill radio.
            Container(
              width: 18,
              height: 18,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: sel
                      ? (dark ? GremionTokens.accentDark : GremionTokens.accent)
                      : (dark
                          ? GremionTokens.borderStrongDark
                          : GremionTokens.borderStrong),
                  width: 2,
                ),
              ),
              alignment: Alignment.center,
              child: sel
                  ? Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color:
                            dark ? GremionTokens.accentDark : GremionTokens.accent,
                      ),
                    )
                  : null,
            ),
            const SizedBox(width: GremionTokens.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(o.text,
                      style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                          color: onSurface)),
                  const SizedBox(height: 2),
                  Text('aktuell ${o.votes} Stimmen',
                      style: TextStyle(fontSize: 11.5, color: muted)),
                ],
              ),
            ),
            Text('$pct%',
                style: TextStyle(
                    fontFamily: GremionTokens.fontMono,
                    fontSize: 12,
                    color: muted)),
          ],
        ),
      ),
    );
  }
}

class _HeliosBallotScreen extends StatelessWidget {
  const _HeliosBallotScreen({required this.election, required this.ballotUrl});
  final Election election;
  final String ballotUrl;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(election.title)),
        body: InAppWebView(
          initialUrlRequest: URLRequest(url: WebUri(ballotUrl)),
          initialSettings: InAppWebViewSettings(
            javaScriptEnabled: true,
            useShouldOverrideUrlLoading: true,
          ),
          shouldOverrideUrlLoading: (controller, navigationAction) async {
            // G-089: defence-in-depth — reject any URL that isn't HTTPS
            // pointed at the Helios host. The boot-time `assertReleaseHttps`
            // guard in main.dart pins `heliosBaseUrl` to https in release,
            // but the WebView itself could be steered to a `data:`,
            // `javascript:`, `about:`, or `file:` URL by a redirect inside
            // the Helios ballot page — none of which we want to render
            // in-app. Predicate is extracted as `isHeliosNavigationAllowed`
            // for direct unit testability.
            return isHeliosNavigationAllowed(
                    navigationAction.request.url, heliosBaseUrl)
                ? NavigationActionPolicy.ALLOW
                : NavigationActionPolicy.CANCEL;
          },
        ),
      );
}

class _CreatePollDialog extends StatefulWidget {
  const _CreatePollDialog();
  @override
  State<_CreatePollDialog> createState() => _CreatePollDialogState();
}

class _CreatePollDialogState extends State<_CreatePollDialog> {
  final _titleCtrl = TextEditingController();
  final List<TextEditingController> _optCtrls = [
    TextEditingController(),
    TextEditingController(),
  ];
  DateTime _deadline = DateTime.now().add(const Duration(days: 7));

  @override
  void dispose() {
    _titleCtrl.dispose();
    for (final c in _optCtrls) {
      c.dispose();
    }
    super.dispose();
  }

  void _addOption() {
    if (_optCtrls.length >= 10) return;
    setState(() => _optCtrls.add(TextEditingController()));
  }

  void _removeOption(int i) {
    if (_optCtrls.length <= 2) return;
    setState(() {
      _optCtrls[i].dispose();
      _optCtrls.removeAt(i);
    });
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Neue Umfrage'),
        content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
              controller: _titleCtrl,
              decoration: const InputDecoration(labelText: 'Frage')),
          const SizedBox(height: 8),
          ...List.generate(
              _optCtrls.length,
              (i) => Row(children: [
                    Expanded(
                        child: TextField(
                      controller: _optCtrls[i],
                      decoration: InputDecoration(labelText: 'Option ${i + 1}'),
                    )),
                    if (_optCtrls.length > 2)
                      IconButton(
                        icon: const Icon(Icons.remove_circle_outline, size: 18),
                        onPressed: () => _removeOption(i),
                      ),
                  ])),
          TextButton.icon(
            onPressed: _addOption,
            icon: const Icon(Icons.add, size: 16),
            label: const Text('Option hinzufügen'),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Frist'),
            trailing: Text(_deadline.toLocal().toString().substring(0, 10)),
            onTap: () async {
              final d = await showDatePicker(
                  context: context,
                  initialDate: _deadline,
                  firstDate: DateTime.now(),
                  lastDate: DateTime(2030));
              if (d != null) setState(() => _deadline = d);
            },
          ),
        ])),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Abbrechen')),
          TextButton(
            onPressed: () => Navigator.pop(context, {
              'title': _titleCtrl.text,
              'deadline': _deadline,
              'options': _optCtrls
                  .map((c) => c.text)
                  .where((o) => o.isNotEmpty)
                  .toList(),
            }),
            child: const Text('Erstellen'),
          ),
        ],
      );
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
