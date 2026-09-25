import 'package:flutter/material.dart';
import 'package:matrix/matrix.dart';
import 'package:provider/provider.dart';

import '../../services/matrix_service.dart';
import '../../tokens/app_tokens.dart';

class RoomScreen extends StatefulWidget {
  const RoomScreen({super.key, required this.roomId});
  final String roomId;

  @override
  State<RoomScreen> createState() => _RoomScreenState();
}

class _RoomScreenState extends State<RoomScreen> {
  final _inputCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  Timeline? _timeline;
  bool _loading = true;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _loadTimeline();
  }

  Future<void> _loadTimeline() async {
    final matrix = context.read<MatrixService>();
    try {
      final timeline = await matrix.getTimeline(widget.roomId);
      if (mounted) {
        setState(() {
          _timeline = timeline;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    // G-048: cancel the Timeline subscriptions before disposing the
    // widget. Without this, the underlying matrix Timeline subscription
    // on room.events keeps firing setState-equivalents into a disposed
    // widget tree (the matrix package exposes cancelSubscriptions() for
    // exactly this purpose).
    try {
      _timeline?.cancelSubscriptions();
    } catch (_) {
      // Defensive — cancelSubscriptions on a half-initialised timeline
      // (e.g. _loadTimeline still in flight, no streams attached yet)
      // would otherwise crash dispose().
    }
    _timeline = null;
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await context.read<MatrixService>().sendMessage(widget.roomId, text);
      _inputCtrl.clear();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('Nachricht konnte nicht gesendet werden')),
        );
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final matrix = context.watch<MatrixService>();
    final room = matrix.client.getRoomById(widget.roomId);

    return Scaffold(
      appBar: AppBar(
        title: Text(room?.getLocalizedDisplayname() ?? widget.roomId),
        actions: [
          // E2E indicator
          if (room?.encrypted == true)
            Padding(
              padding: const EdgeInsets.only(right: AppSpacing.md),
              child: Icon(Icons.lock_outlined,
                  color: AppColors.of(context).success, size: 20),
            ),
        ],
      ),
      body: Column(
        children: [
          Expanded(child: _buildTimeline()),
          _buildInput(),
        ],
      ),
    );
  }

  Widget _buildTimeline() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    final events = _timeline?.events ?? [];
    if (events.isEmpty) {
      return Center(
          child: Text('Noch keine Nachrichten',
              style: AppTextStyles.of(context).bodyMuted));
    }

    return ListView.builder(
      controller: _scrollCtrl,
      reverse: true,
      padding: const EdgeInsets.all(AppSpacing.md),
      itemCount: events.length,
      itemBuilder: (_, index) => _MessageBubble(event: events[index]),
    );
  }

  Widget _buildInput() {
    final colors = AppColors.of(context);
    return Container(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.border)),
      ),
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md, vertical: AppSpacing.sm),
      child: Row(
        children: [
          IconButton(
            icon: Icon(Icons.attach_file_outlined, color: colors.textMuted),
            onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Dateifreigabe — folgt')),
            ),
          ),
          Expanded(
            child: TextField(
              controller: _inputCtrl,
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(
                hintText: 'Nachricht…',
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                fillColor: Colors.transparent,
              ),
              onSubmitted: (_) => _send(),
            ),
          ),
          IconButton(
            icon: _sending
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Icon(Icons.send_rounded, color: colors.primary),
            onPressed: _send,
          ),
        ],
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.event});
  final Event event;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final text = AppTextStyles.of(context);
    final isMe = event.senderId == event.room.client.userID;
    final body = event.body;
    final time = TimeOfDay.fromDateTime(event.originServerTs).format(context);

    return Align(
      alignment: isMe ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.72,
        ),
        margin: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm,
        ),
        decoration: BoxDecoration(
          color: isMe ? colors.msgMine : colors.msgOther,
          borderRadius: BorderRadius.circular(AppRadius.md),
          border: isMe ? null : Border.all(color: colors.border),
        ),
        child: Column(
          crossAxisAlignment:
              isMe ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            if (!isMe)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                child: Text(
                  event.senderFromMemoryOrFallback.displayName ??
                      event.senderId,
                  style: text.caption.copyWith(color: colors.primary),
                ),
              ),
            Text(body, style: text.body),
            const SizedBox(height: AppSpacing.xs),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(time, style: text.caption),
                if (event.room.encrypted == true) ...[
                  const SizedBox(width: 4),
                  Icon(Icons.lock_outlined, size: 10, color: colors.e2eIcon),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}
