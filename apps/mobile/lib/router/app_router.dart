// mobile/lib/router/app_router.dart
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../screens/auth/login_screen.dart';
import '../screens/shell/tab_shell.dart';
import '../screens/home/home_screen.dart';
import '../screens/chat/room_list_screen.dart';
import '../screens/chat/room_screen.dart';
import '../screens/files/files_screen.dart';
import '../screens/calendar/calendar_screen.dart';
import '../screens/deck/deck_screen.dart';
import '../screens/elections/elections_screen.dart';
import '../screens/groups/groups_screen.dart';
import '../screens/settings/settings_screen.dart';
import '../services/auth_service.dart';
import '../tokens/committee_hue.dart';
import '../tokens/design_tokens.dart';

GoRouter buildRouter(AuthService auth) => GoRouter(
      initialLocation: '/home',
      redirect: (ctx, state) {
        if (!auth.isAuthenticated &&
            !state.matchedLocation.startsWith('/login')) {
          return '/login';
        }
        if (auth.isAuthenticated &&
            state.matchedLocation.startsWith('/login')) {
          return '/home';
        }
        return null;
      },
      refreshListenable: auth,
      routes: [
        GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
        // Branch order MUST match the tab order in tab_shell.dart
        // (HOME · TERMINE · DECK · CHAT · WAHL · AKTE · PROFIL) — goBranch
        // switches by index. Indices: 0 /home · 1 /calendar · 2 /deck ·
        // 3 /chat · 4 /elections · 5 /files · 6 /more.
        StatefulShellRoute.indexedStack(
          builder: (_, __, shell) => TabShell(navigationShell: shell),
          branches: [
            StatefulShellBranch(routes: [
              GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
            ]),
            StatefulShellBranch(routes: [
              GoRoute(
                  path: '/calendar',
                  builder: (_, __) => const CalendarScreen()),
            ]),
            StatefulShellBranch(routes: [
              GoRoute(path: '/deck', builder: (_, __) => const DeckScreen()),
            ]),
            StatefulShellBranch(routes: [
              GoRoute(
                path: '/chat',
                builder: (_, __) => const RoomListScreen(),
                routes: [
                  GoRoute(
                    path: ':roomId',
                    builder: (_, s) =>
                        RoomScreen(roomId: s.pathParameters['roomId']!),
                  ),
                ],
              ),
            ]),
            StatefulShellBranch(routes: [
              GoRoute(
                  path: '/elections',
                  builder: (_, __) => const ElectionsScreen()),
            ]),
            StatefulShellBranch(routes: [
              GoRoute(path: '/files', builder: (_, __) => const FilesScreen()),
            ]),
            StatefulShellBranch(routes: [
              GoRoute(
                path: '/more',
                builder: (_, __) => const _MoreScreen(),
                routes: [
                  GoRoute(
                      path: 'groups', builder: (_, __) => const GroupsScreen()),
                  GoRoute(
                      path: 'settings',
                      builder: (_, __) => const SettingsScreen()),
                ],
              ),
            ]),
          ],
        ),
      ],
    );

class _MoreScreen extends StatelessWidget {
  const _MoreScreen();
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            const MScreenHead(
              eyebrow: 'StuRaOS · Konto',
              title: 'Profil',
              sub: 'Gruppen und Einstellungen',
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(GremionTokens.s4,
                    GremionTokens.s4, GremionTokens.s4, GremionTokens.s8),
                children: [
                  _MoreRow(
                    icon: Icons.group_outlined,
                    label: 'Gruppen',
                    sub: 'Deine Gremien und Räume',
                    onTap: () => context.go('/more/groups'),
                  ),
                  const SizedBox(height: GremionTokens.s2),
                  _MoreRow(
                    icon: Icons.settings_outlined,
                    label: 'Einstellungen',
                    sub: 'Benachrichtigungen, Abmelden',
                    onTap: () => context.go('/more/settings'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MoreRow extends StatelessWidget {
  const _MoreRow(
      {required this.icon,
      required this.label,
      required this.sub,
      required this.onTap});
  final IconData icon;
  final String label;
  final String sub;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    return InkWell(
      borderRadius: GremionTokens.rMd,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(GremionTokens.s4),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: GremionTokens.rMd,
          border: Border.all(color: Theme.of(context).dividerColor),
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: onSurface),
            const SizedBox(width: GremionTokens.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label,
                      style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                          color: onSurface)),
                  const SizedBox(height: 2),
                  Text(sub, style: TextStyle(fontSize: 12, color: muted)),
                ],
              ),
            ),
            Icon(Icons.chevron_right, size: 20, color: muted),
          ],
        ),
      ),
    );
  }
}
