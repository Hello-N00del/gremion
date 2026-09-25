// mobile/lib/screens/chat/room_list_screen.dart
//
// Phase 5.2 (v5 mobile rebuild) — the Matrix room list off the Material
// AppBar/ListTile onto the institutional v5 look (mobile-app.jsx:88-111 /
// mobile.css:169-190): header eyebrow "Matrix · E2E" + "Nachrichten" title +
// "N Räume · N ungelesen" sub; round mono-initial avatars, a pin glyph for
// favourites, a mono timestamp, and an accent unread pill. The real SSE sync,
// CrossSigningBanner and navigation are preserved. German copy.
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:matrix/matrix.dart';
import 'package:provider/provider.dart';

import '../../services/matrix_service.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';

class RoomListScreen extends StatelessWidget {
  const RoomListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final matrix = context.watch<MatrixService>();
    final rooms = matrix.getRooms();
    final unreadTotal = rooms.fold<int>(0, (s, r) => s + r.notificationCount);
    final unreadRooms = rooms.where((r) => r.notificationCount > 0).length;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            MScreenHead(
              eyebrow: 'Matrix · E2E',
              title: 'Nachrichten',
              sub:
                  '${rooms.length} ${rooms.length == 1 ? 'Raum' : 'Räume'} · $unreadRooms ungelesen',
              trailing: IconButton(
                icon: Icon(Icons.settings_outlined,
                    size: 20,
                    color: Theme.of(context).brightness == Brightness.dark
                        ? GremionTokens.inkMutedDark
                        : GremionTokens.inkMuted),
                onPressed: () => context.go('/more/settings'),
              ),
            ),
            // #261: CrossSigningBanner removed — it was dead code (its gating
            // prefs `crossSigningSkipped`/`crossSigningCompleted` were never
            // written anywhere, so it never showed, and its "/onboarding/
            // cross-signing" route does not exist in app_router). There is
            // currently NO in-app path to set up Matrix cross-signing / device
            // verification; E2EE devices stay unverified. Tracked as an
            // explicit E2EE-verification gap (see branch report) to implement a
            // real Bootstrap-based onboarding flow before re-adding a banner.
            Expanded(child: _RoomList(rooms: rooms, total: unreadTotal)),
          ],
        ),
      ),
    );
  }
}

class _RoomList extends StatelessWidget {
  const _RoomList({required this.rooms, required this.total});
  final List<Room> rooms;
  final int total;

  @override
  Widget build(BuildContext context) {
    final matrix = context.watch<MatrixService>();
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;

    if (rooms.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.chat_bubble_outline, size: 56, color: muted),
            const SizedBox(height: GremionTokens.s3),
            Text('Noch keine Unterhaltungen.',
                style: TextStyle(fontSize: 13, color: muted)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async => matrix.client.sync(),
      child: ListView.separated(
        padding: const EdgeInsets.only(top: GremionTokens.s1),
        itemCount: rooms.length,
        separatorBuilder: (_, __) =>
            Divider(height: 1, color: Theme.of(context).dividerColor),
        itemBuilder: (context, index) => _RoomTile(room: rooms[index]),
      ),
    );
  }
}

class _RoomTile extends StatelessWidget {
  const _RoomTile({required this.room});
  final Room room;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    final name = room.getLocalizedDisplayname();
    final lastEvent = room.lastEvent;
    final unread = room.notificationCount;
    final pinned = room.isFavourite;
    final hueColor = committeeColor(name, dark: dark);

    return InkWell(
      onTap: () => context.push('/chat/${room.id}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(
            horizontal: GremionTokens.s4, vertical: GremionTokens.s3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Round mono-initial avatar, committee-hued.
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: hueColor,
                shape: BoxShape.circle,
              ),
              alignment: Alignment.center,
              child: Text(
                committeeMonogram(name),
                style: const TextStyle(
                  fontFamily: GremionTokens.fontDisplay,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: Colors.white,
                ),
              ),
            ),
            const SizedBox(width: GremionTokens.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      if (pinned)
                        Padding(
                          padding: const EdgeInsets.only(right: 4),
                          child: Icon(Icons.push_pin, size: 12, color: muted),
                        ),
                      Expanded(
                        child: Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                              color: onSurface),
                        ),
                      ),
                      const SizedBox(width: GremionTokens.s2),
                      if (lastEvent != null)
                        Text(
                          _timestamp(lastEvent.originServerTs),
                          style: TextStyle(
                              fontFamily: GremionTokens.fontMono,
                              fontSize: 10,
                              color: muted),
                        ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          lastEvent?.body ?? 'Keine Nachrichten',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: muted),
                        ),
                      ),
                      if (unread > 0) ...[
                        const SizedBox(width: GremionTokens.s2),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 1),
                          decoration: const BoxDecoration(
                            color: GremionTokens.accent,
                            borderRadius: BorderRadius.all(Radius.circular(10)),
                          ),
                          child: Text(
                            unread > 99 ? '99+' : '$unread',
                            style: const TextStyle(
                                fontFamily: GremionTokens.fontMono,
                                fontSize: 10,
                                fontWeight: FontWeight.w600,
                                color: GremionTokens.surface),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _timestamp(DateTime ts) {
    final now = DateTime.now();
    final sameDay =
        ts.year == now.year && ts.month == now.month && ts.day == now.day;
    if (sameDay) {
      return '${ts.hour.toString().padLeft(2, '0')}:${ts.minute.toString().padLeft(2, '0')}';
    }
    final diff = now.difference(ts).inDays;
    if (diff < 7) {
      const wd = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      return wd[ts.weekday - 1];
    }
    return '${ts.day}.${ts.month}.';
  }
}
