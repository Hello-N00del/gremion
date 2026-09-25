// mobile/lib/screens/groups/groups_screen.dart
//
// Phase 5.5 (v5 mobile rebuild) — Gruppen restyled onto GremionTokens: a v5 page
// head + token group cards (committee-hued monogram, member chips, chat/folder
// shortcuts). getGroups + navigation preserved. German copy.
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../brand.dart';
import '../../models/group.dart';
import '../../services/api_client.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';

class GroupsScreen extends StatefulWidget {
  const GroupsScreen({super.key});
  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  List<Group> _groups = [];
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
      final groups = await context.read<StuRaOSApiClient>().getGroups();
      if (mounted) {
        setState(() {
          _groups = groups;
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

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final onSurface = Theme.of(context).colorScheme.onSurface;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            MScreenHead(
              eyebrow: '${Brand.product} · Gremien',
              title: 'Gruppen',
              sub: '${_groups.length} Gruppen',
            ),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? Center(
                          child:
                              Column(mainAxisSize: MainAxisSize.min, children: [
                          Text(_error!,
                              style: TextStyle(
                                  color: dark
                                      ? GremionTokens.rustDark
                                      : GremionTokens.rust)),
                          TextButton(
                              onPressed: _load,
                              child: const Text('Erneut laden')),
                        ]))
                      : _groups.isEmpty
                          ? Center(
                              child: Text('Keine Gruppen.',
                                  style: TextStyle(fontSize: 13, color: muted)))
                          : ListView.builder(
                              padding: const EdgeInsets.fromLTRB(
                                  GremionTokens.s4,
                                  GremionTokens.s4,
                                  GremionTokens.s4,
                                  GremionTokens.s8),
                              itemCount: _groups.length,
                              itemBuilder: (_, i) {
                                final g = _groups[i];
                                return Container(
                                  margin: const EdgeInsets.only(
                                      bottom: GremionTokens.s2),
                                  clipBehavior: Clip.antiAlias,
                                  decoration: BoxDecoration(
                                    color:
                                        Theme.of(context).colorScheme.surface,
                                    borderRadius: GremionTokens.rMd,
                                    border: Border.all(
                                        color: Theme.of(context).dividerColor),
                                  ),
                                  child: Theme(
                                    data: Theme.of(context).copyWith(
                                        dividerColor: Colors.transparent),
                                    child: ExpansionTile(
                                      leading: Container(
                                        width: 38,
                                        height: 38,
                                        decoration: BoxDecoration(
                                          color: committeeColor(g.name,
                                              dark: dark),
                                          shape: BoxShape.circle,
                                        ),
                                        alignment: Alignment.center,
                                        child: Text(
                                          committeeMonogram(g.name),
                                          style: const TextStyle(
                                              fontFamily: GremionTokens.fontMono,
                                              fontSize: 11,
                                              fontWeight: FontWeight.w700,
                                              color: Colors.white),
                                        ),
                                      ),
                                      title: Text(g.name,
                                          style: TextStyle(
                                              fontSize: 14,
                                              fontWeight: FontWeight.w500,
                                              color: onSurface)),
                                      subtitle: Text(
                                          '${g.members.length} Mitglieder',
                                          style: TextStyle(
                                              fontSize: 12, color: muted)),
                                      children: [
                                        if (g.matrixRoomId != null)
                                          ListTile(
                                            leading: Icon(
                                                Icons.chat_bubble_outline,
                                                size: 18,
                                                color: onSurface),
                                            title: Text('Chat-Raum öffnen',
                                                style: TextStyle(
                                                    fontSize: 13.5,
                                                    color: onSurface)),
                                            onTap: () => context.push(
                                                '/chat/${g.matrixRoomId}'),
                                          ),
                                        if (g.ncFolderPath != null)
                                          ListTile(
                                            leading: Icon(Icons.folder_outlined,
                                                size: 18, color: onSurface),
                                            title: Text(
                                                'Gemeinsamen Ordner öffnen',
                                                style: TextStyle(
                                                    fontSize: 13.5,
                                                    color: onSurface)),
                                            onTap: () => context.go('/files'),
                                          ),
                                        Padding(
                                          padding: const EdgeInsets.fromLTRB(
                                              GremionTokens.s4,
                                              0,
                                              GremionTokens.s4,
                                              GremionTokens.s4),
                                          child: Wrap(
                                            spacing: GremionTokens.s1,
                                            runSpacing: GremionTokens.s1,
                                            children: g.members
                                                .map((m) => Chip(
                                                      label: Text(m.displayName,
                                                          style: TextStyle(
                                                              fontSize: 11.5,
                                                              color:
                                                                  onSurface)),
                                                      visualDensity:
                                                          VisualDensity.compact,
                                                    ))
                                                .toList(),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),
            ),
          ],
        ),
      ),
    );
  }
}
