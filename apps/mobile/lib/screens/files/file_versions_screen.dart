import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/nc_file.dart';
import '../../models/nc_file_version.dart';
import '../../services/api_client.dart';
import '../../tokens/app_tokens.dart';

class FileVersionsScreen extends StatefulWidget {
  const FileVersionsScreen({required this.file, super.key});
  final NcFile file;
  @override
  State<FileVersionsScreen> createState() => _FileVersionsScreenState();
}

class _FileVersionsScreenState extends State<FileVersionsScreen> {
  List<NcFileVersion> _versions = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final versions = await context
          .read<StuRaOSApiClient>()
          .getFileVersions(widget.file.path);
      if (mounted) {
        setState(() {
          _versions = versions;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  Future<void> _restore(NcFileVersion version) async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
              title: const Text('Version wiederherstellen?'),
              content: Text(
                  'Version vom ${version.modified.toLocal()} wiederherstellen?'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('Abbrechen')),
                TextButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('Wiederherstellen')),
              ],
            ));
    if (confirmed != true || !mounted) return;
    await context
        .read<StuRaOSApiClient>()
        .restoreFileVersion(widget.file.path, version.versionId);
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final text = AppTextStyles.of(context);
    return Scaffold(
      appBar: AppBar(title: Text('Verlauf — ${widget.file.name}')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _versions.isEmpty
              ? const Center(child: Text('Keine früheren Versionen'))
              : ListView.separated(
                  itemCount: _versions.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final v = _versions[i];
                    return ListTile(
                      title: Text(v.modified.toLocal().toString(),
                          style: text.body),
                      subtitle: Text('${(v.size / 1024).toStringAsFixed(1)} KB',
                          style: text.caption),
                      trailing: TextButton(
                          onPressed: () => _restore(v),
                          child: const Text('Wiederherstellen')),
                    );
                  }),
    );
  }
}
