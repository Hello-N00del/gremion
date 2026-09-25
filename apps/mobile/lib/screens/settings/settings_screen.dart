// mobile/lib/screens/settings/settings_screen.dart
//
// Phase 5.5 (v5 mobile rebuild) — Einstellungen restyled onto GremionTokens: a v5
// page head, a committee-hued profile card, a token notification-toggle
// section and a sign-out row. SharedPreferences persistence and logout are
// preserved. German copy.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../brand.dart';
import '../../services/auth_service.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';

const _notifKeys = [
  ('messages', 'Chat-Nachrichten'),
  ('calendar', 'Kalender-Erinnerungen'),
  ('polls_new', 'Neue Umfragen'),
  ('polls_closing', 'Umfragen enden bald'),
  ('elections_open', 'Wahlen öffnen'),
  ('elections_closing', 'Wahlen enden bald'),
];

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final Map<String, bool> _notifToggles = {};
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _loadPrefs();
  }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      for (final (key, _) in _notifKeys) {
        _notifToggles[key] = prefs.getBool('notif_$key') ?? true;
      }
      _loaded = true;
    });
  }

  Future<void> _setNotif(String key, bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('notif_$key', value);
    if (mounted) setState(() => _notifToggles[key] = value);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final session = auth.session;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    final danger = dark ? GremionTokens.rustDark : GremionTokens.rust;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            const MScreenHead(
              eyebrow: '${Brand.product} · Konto',
              title: 'Einstellungen',
            ),
            Expanded(
              child: !_loaded
                  ? const Center(child: CircularProgressIndicator())
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(GremionTokens.s4,
                          GremionTokens.s4, GremionTokens.s4, GremionTokens.s8),
                      children: [
                        if (session != null) ...[
                          Container(
                            padding: const EdgeInsets.all(GremionTokens.s4),
                            decoration: BoxDecoration(
                              color: Theme.of(context).colorScheme.surface,
                              borderRadius: GremionTokens.rMd,
                              border: Border.all(
                                  color: Theme.of(context).dividerColor),
                            ),
                            child: Row(
                              children: [
                                Container(
                                  width: 44,
                                  height: 44,
                                  decoration: BoxDecoration(
                                    color: committeeColor(session.matrixUserId,
                                        dark: dark),
                                    shape: BoxShape.circle,
                                  ),
                                  alignment: Alignment.center,
                                  child: Text(
                                    session.matrixUserId.length > 1
                                        ? session.matrixUserId[1].toUpperCase()
                                        : '?',
                                    style: const TextStyle(
                                        fontFamily: GremionTokens.fontDisplay,
                                        fontSize: 16,
                                        fontWeight: FontWeight.w600,
                                        color: Colors.white),
                                  ),
                                ),
                                const SizedBox(width: GremionTokens.s3),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(session.matrixUserId,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                              fontSize: 14,
                                              fontWeight: FontWeight.w500,
                                              color: onSurface)),
                                      const SizedBox(height: 2),
                                      Text(session.role.name,
                                          style: TextStyle(
                                              fontFamily: GremionTokens.fontMono,
                                              fontSize: 11,
                                              letterSpacing: 0.4,
                                              color: muted)),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: GremionTokens.s5),
                        ],
                        Padding(
                          padding: const EdgeInsets.only(
                              left: 2, bottom: GremionTokens.s2),
                          child: Text('BENACHRICHTIGUNGEN',
                              style: TextStyle(
                                  fontFamily: GremionTokens.fontMono,
                                  fontSize: 10.5,
                                  letterSpacing: 1.4,
                                  color: muted)),
                        ),
                        Container(
                          clipBehavior: Clip.antiAlias,
                          decoration: BoxDecoration(
                            color: Theme.of(context).colorScheme.surface,
                            borderRadius: GremionTokens.rMd,
                            border: Border.all(
                                color: Theme.of(context).dividerColor),
                          ),
                          child: Column(
                            children: [
                              for (var i = 0; i < _notifKeys.length; i++) ...[
                                if (i > 0)
                                  Divider(
                                      height: 1,
                                      color: Theme.of(context).dividerColor),
                                SwitchListTile(
                                  title: Text(_notifKeys[i].$2,
                                      style: TextStyle(
                                          fontSize: 14, color: onSurface)),
                                  value:
                                      _notifToggles[_notifKeys[i].$1] ?? true,
                                  onChanged: (v) =>
                                      _setNotif(_notifKeys[i].$1, v),
                                  activeThumbColor: GremionTokens.accent,
                                ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(height: GremionTokens.s5),
                        InkWell(
                          borderRadius: GremionTokens.rMd,
                          onTap: () => auth.logout(),
                          child: Container(
                            padding: const EdgeInsets.all(GremionTokens.s4),
                            decoration: BoxDecoration(
                              color: dark
                                  ? GremionTokens.rustSoftDark
                                  : GremionTokens.rustSoft,
                              borderRadius: GremionTokens.rMd,
                            ),
                            child: Row(
                              children: [
                                Icon(Icons.logout, size: 20, color: danger),
                                const SizedBox(width: GremionTokens.s3),
                                Text('Abmelden',
                                    style: TextStyle(
                                        fontSize: 14,
                                        fontWeight: FontWeight.w500,
                                        color: danger)),
                              ],
                            ),
                          ),
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
