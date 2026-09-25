// mobile/lib/screens/polls/polls_screen.dart
//
// Phase 5.3 (v5 mobile rebuild) — the Nextcloud-Polls list restyled onto the
// institutional v5 look: a v5 page head + token-card PollWidgets. The poll
// backend (getPolls / createPoll / votePoll) and the RoleGuard create FAB are
// preserved. German copy.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/poll.dart';
import '../../models/user_session.dart';
import '../../services/api_client.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';
import '../../widgets/poll_widget.dart';
import '../../widgets/role_guard.dart';

class PollsScreen extends StatefulWidget {
  const PollsScreen({super.key});
  @override
  State<PollsScreen> createState() => _PollsScreenState();
}

class _PollsScreenState extends State<PollsScreen> {
  List<Poll> _polls = [];
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
      final polls = await context.read<StuRaOSApiClient>().getPolls();
      if (mounted) {
        setState(() {
          _polls = polls;
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

  Future<void> _createPoll() async {
    final result = await showDialog<Map<String, dynamic>>(
        context: context, builder: (_) => const _CreatePollDialog());
    if (result == null) return;
    if (!mounted) return;
    await context.read<StuRaOSApiClient>().createPoll(
          result['title'] as String,
          List<String>.from(result['options'] as List),
          result['deadline'] as DateTime,
          result['group_id'] as String,
        );
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            MScreenHead(
              eyebrow: 'Nextcloud Polls',
              title: 'Umfragen',
              sub: '${_polls.length} aktiv',
            ),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? _ErrorView(message: _error!, onRetry: _load)
                      : _polls.isEmpty
                          ? Center(
                              child: Text('Keine aktiven Umfragen.',
                                  style: TextStyle(fontSize: 13, color: muted)))
                          : RefreshIndicator(
                              onRefresh: _load,
                              child: ListView.builder(
                                padding: const EdgeInsets.fromLTRB(
                                    GremionTokens.s4,
                                    GremionTokens.s3,
                                    GremionTokens.s4,
                                    GremionTokens.s8),
                                itemCount: _polls.length,
                                itemBuilder: (_, i) =>
                                    PollWidget(poll: _polls[i]),
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
          onPressed: _createPoll,
          child: const Icon(Icons.add),
        ),
      ),
    );
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

class _CreatePollDialog extends StatefulWidget {
  const _CreatePollDialog();
  @override
  State<_CreatePollDialog> createState() => _CreatePollDialogState();
}

class _CreatePollDialogState extends State<_CreatePollDialog> {
  final _titleCtrl = TextEditingController();
  final _opt1Ctrl = TextEditingController();
  final _opt2Ctrl = TextEditingController();
  final _groupCtrl = TextEditingController();
  DateTime _deadline = DateTime.now().add(const Duration(days: 7));

  @override
  void dispose() {
    _titleCtrl.dispose();
    _opt1Ctrl.dispose();
    _opt2Ctrl.dispose();
    _groupCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Neue Umfrage'),
        content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
              controller: _titleCtrl,
              decoration: const InputDecoration(labelText: 'Frage')),
          TextField(
              controller: _opt1Ctrl,
              decoration: const InputDecoration(labelText: 'Option 1')),
          TextField(
              controller: _opt2Ctrl,
              decoration: const InputDecoration(labelText: 'Option 2')),
          TextField(
              controller: _groupCtrl,
              decoration: const InputDecoration(labelText: 'Gruppen-ID')),
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
              'group_id': _groupCtrl.text,
              'options': [_opt1Ctrl.text, _opt2Ctrl.text]
                  .where((o) => o.isNotEmpty)
                  .toList(),
            }),
            child: const Text('Erstellen'),
          ),
        ],
      );
}
