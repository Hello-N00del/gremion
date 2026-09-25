// mobile/lib/widgets/poll_widget.dart
//
// Phase 5.3 (v5 mobile rebuild) — a single Nextcloud poll as a v5 token card
// with accent fill-bar result rows and per-option %. The vote action
// (votePoll) is preserved. German copy.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/poll.dart';
import '../services/api_client.dart';
import '../tokens/design_tokens.dart';

class PollWidget extends StatefulWidget {
  const PollWidget({required this.poll, super.key});
  final Poll poll;

  @override
  State<PollWidget> createState() => _PollWidgetState();
}

class _PollWidgetState extends State<PollWidget> {
  bool _voting = false;
  bool _voted = false;

  @override
  void initState() {
    super.initState();
    _voted = widget.poll.voted;
  }

  Future<void> _vote(String optionId) async {
    if (_voting || _voted) return;
    setState(() => _voting = true);
    try {
      await context.read<StuRaOSApiClient>().votePoll(widget.poll.id, optionId);
      setState(() => _voted = true);
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
    final onSurface = Theme.of(context).colorScheme.onSurface;
    final accent = dark ? GremionTokens.accentDark : GremionTokens.accent;
    final accentInk = dark ? GremionTokens.accentInkDark : GremionTokens.accentInk;
    final poll = widget.poll;
    final totalVotes = poll.options.fold(0, (s, o) => s + o.votes);

    return Container(
      margin: const EdgeInsets.only(bottom: GremionTokens.s2 + 2),
      padding: const EdgeInsets.all(GremionTokens.s4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: GremionTokens.rMd,
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(Icons.poll_outlined, size: 14, color: accentInk),
          const SizedBox(width: 5),
          Text('UMFRAGE',
              style: TextStyle(
                  fontFamily: GremionTokens.fontMono,
                  fontSize: 9.5,
                  letterSpacing: 1.2,
                  fontWeight: FontWeight.w600,
                  color: accentInk)),
        ]),
        const SizedBox(height: GremionTokens.s2),
        Text(poll.title,
            style: TextStyle(
                fontFamily: GremionTokens.fontDisplay,
                fontSize: 16,
                fontWeight: FontWeight.w500,
                height: 1.2,
                color: onSurface)),
        const SizedBox(height: GremionTokens.s3),
        ...poll.options.map((option) {
          final pct = totalVotes > 0 ? option.votes / totalVotes : 0.0;
          return GestureDetector(
            onTap: _voted ? null : () => _vote(option.id),
            child: Container(
              margin: const EdgeInsets.only(bottom: GremionTokens.s2),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: dark ? GremionTokens.surface2Dark : GremionTokens.surface2,
                borderRadius: GremionTokens.rSm,
                border: Border.all(color: Theme.of(context).dividerColor),
              ),
              child: Stack(
                children: [
                  // Accent fill bar (only once voted, to reveal results).
                  if (_voted)
                    Positioned.fill(
                      child: FractionallySizedBox(
                        alignment: Alignment.centerLeft,
                        widthFactor: pct.clamp(0.0, 1.0),
                        child: Container(
                          color: (dark
                                  ? GremionTokens.accentSoftDark
                                  : GremionTokens.accentSoft)
                              .withValues(alpha: dark ? 1 : 0.7),
                        ),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                        horizontal: GremionTokens.s3 + 2, vertical: 11),
                    child: Row(children: [
                      Expanded(
                          child: Text(option.text,
                              style: TextStyle(
                                  fontSize: 13.5,
                                  fontWeight: FontWeight.w500,
                                  color: onSurface))),
                      if (_voted)
                        Text('${(pct * 100).round()}%',
                            style: TextStyle(
                                fontFamily: GremionTokens.fontMono,
                                fontSize: 12,
                                color: muted)),
                    ]),
                  ),
                ],
              ),
            ),
          );
        }),
        if (_voting)
          Padding(
            padding: const EdgeInsets.only(top: GremionTokens.s1),
            child: LinearProgressIndicator(
                color: accent, backgroundColor: Theme.of(context).dividerColor),
          ),
      ]),
    );
  }
}
