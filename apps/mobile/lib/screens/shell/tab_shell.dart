// mobile/lib/screens/shell/tab_shell.dart
//
// Design v8 Part G — bottom tab shell expanded to the 7-tab member-basics
// layout (handoff MTabbar, design_files/mobile/mobile-app.jsx:300):
// HOME · TERMINE · DECK · CHAT · WAHL · AKTE · PROFIL, UPPERCASE labels, dark
// surface. (v8 renamed KALENDER→TERMINE and inserted DECK at position 3.)
// The CHAT destination carries a live unread dot driven by the Matrix client.
// Branch order here MUST match the StatefulShellRoute branch order in
// app_router.dart (goBranch switches by index).
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/matrix_service.dart';
import '../../tokens/design_tokens.dart';

class TabShell extends StatelessWidget {
  const TabShell({required this.navigationShell, super.key});
  final StatefulNavigationShell navigationShell;

  // (icon, label) in branch order. Paths are documented for reference;
  // switching is by index via navigationShell.goBranch.
  static const _tabs = [
    (icon: Icons.home_outlined, label: 'HOME'), // /home
    (icon: Icons.calendar_today_outlined, label: 'TERMINE'), // /calendar
    (icon: Icons.view_kanban_outlined, label: 'DECK'), // /deck
    (icon: Icons.chat_bubble_outline, label: 'CHAT'), // /chat
    (icon: Icons.how_to_vote_outlined, label: 'WAHL'), // /elections
    (icon: Icons.folder_outlined, label: 'AKTE'), // /files
    (icon: Icons.person_outline, label: 'PROFIL'), // /more
  ];

  // CHAT moved from index 2 → 3 when DECK was inserted at index 2.
  static const _chatTabIndex = 3;

  @override
  Widget build(BuildContext context) {
    // Live unread total across joined rooms — drives the CHAT dot. Rebuilds on
    // Matrix sync via the watched ChangeNotifier; guarded so an uninitialised
    // client just yields 0.
    final matrix = context.watch<MatrixService>();
    final unread = _unreadCount(matrix);

    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: GremionTokens.borderDark)),
        ),
        child: NavigationBar(
          backgroundColor: GremionTokens.surfaceDark,
          indicatorColor: GremionTokens.accentSoftDark,
          selectedIndex: navigationShell.currentIndex,
          onDestinationSelected: (i) => navigationShell.goBranch(i,
              initialLocation: i == navigationShell.currentIndex),
          destinations: [
            for (var i = 0; i < _tabs.length; i++)
              NavigationDestination(
                icon: _icon(_tabs[i].icon, GremionTokens.inkMutedDark,
                    badge: i == _chatTabIndex && unread > 0),
                selectedIcon: _icon(_tabs[i].icon, GremionTokens.accentDark,
                    badge: i == _chatTabIndex && unread > 0),
                label: _tabs[i].label,
              ),
          ],
        ),
      ),
    );
  }

  Widget _icon(IconData icon, Color color, {required bool badge}) {
    final base = Icon(icon, color: color);
    if (!badge) return base;
    return Badge(
      smallSize: 8,
      backgroundColor: GremionTokens.emberDark,
      child: base,
    );
  }

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
}
