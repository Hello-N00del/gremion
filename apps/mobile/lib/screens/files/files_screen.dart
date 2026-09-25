// mobile/lib/screens/files/files_screen.dart
//
// Phase 5.4 (v5 mobile rebuild) — the Nextcloud browser in the v5 look: a
// header eyebrow "Nextcloud" + "Dateien" title + a mono breadcrumb of the
// current path, then `m-file-row` tiles (see NcFileTile). Upload / new folder /
// delete and the folder back-navigation are preserved. German copy.
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:provider/provider.dart';
import '../../models/nc_file.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../tokens/committee_hue.dart';
import '../../tokens/design_tokens.dart';
import '../../widgets/nc_file_tile.dart';
import 'file_viewer_screen.dart';

class FilesScreen extends StatefulWidget {
  const FilesScreen({super.key});
  @override
  State<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends State<FilesScreen> {
  String _path = '/';
  List<NcFile> _files = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String? _parentPath() {
    if (_path == '/') return null;
    final trimmed =
        _path.endsWith('/') ? _path.substring(0, _path.length - 1) : _path;
    final idx = trimmed.lastIndexOf('/');
    return idx <= 0 ? '/' : trimmed.substring(0, idx + 1);
  }

  void _navigateUp() {
    final parent = _parentPath();
    if (parent == null) return;
    setState(() {
      _path = parent;
    });
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final files = await context.read<StuRaOSApiClient>().listFiles(_path);
      setState(() {
        _files = files;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
      });
    } finally {
      setState(() {
        _loading = false;
      });
    }
  }

  Future<void> _upload() async {
    final api = context.read<StuRaOSApiClient>();
    final result = await FilePicker.platform.pickFiles(withData: true);
    if (result == null || result.files.isEmpty) return;
    final file = result.files.first;
    final bytes = file.bytes;
    if (bytes == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Datei konnte nicht gelesen werden')));
      }
      return;
    }
    try {
      await api.uploadFile(_path, file.name, bytes);
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Upload fehlgeschlagen: $e')));
      }
    }
  }

  Future<void> _createFolder() async {
    final name = await _promptText(context, 'Name des neuen Ordners');
    if (name == null || name.isEmpty) return;
    if (!mounted) return;
    await context.read<StuRaOSApiClient>().createFolder('$_path$name');
    await _load();
  }

  Future<void> _delete(NcFile file) async {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final dangerColor = dark ? GremionTokens.rustDark : GremionTokens.rust;
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
              title: const Text('Löschen?'),
              content: Text(
                  '"${file.name}" löschen? Dies kann nicht rückgängig gemacht werden.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('Abbrechen')),
                TextButton(
                    onPressed: () => Navigator.pop(context, true),
                    child:
                        Text('Löschen', style: TextStyle(color: dangerColor))),
              ],
            ));
    if (confirmed != true) return;
    if (!mounted) return;
    await context.read<StuRaOSApiClient>().deleteFile(file.path);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final canWrite = context.watch<AuthService>().session?.canWrite() ?? false;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final inSubfolder = _path != '/';

    return PopScope(
      canPop: !inSubfolder,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && inSubfolder) _navigateUp();
      },
      child: Scaffold(
        body: SafeArea(
          bottom: false,
          child: Column(
            children: [
              MScreenHead(
                eyebrow: 'Nextcloud',
                title: 'Dateien',
                sub: _path,
                subMono: true,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (inSubfolder)
                      IconButton(
                        icon: Icon(Icons.arrow_upward, size: 20, color: muted),
                        tooltip: 'Übergeordneter Ordner',
                        onPressed: _navigateUp,
                      ),
                    if (canWrite)
                      IconButton(
                        icon: Icon(Icons.create_new_folder_outlined,
                            size: 20, color: muted),
                        onPressed: _createFolder,
                      ),
                    if (canWrite)
                      IconButton(
                        icon:
                            Icon(Icons.upload_outlined, size: 20, color: muted),
                        onPressed: _upload,
                      ),
                  ],
                ),
              ),
              Expanded(
                child: _loading
                    ? const Center(child: CircularProgressIndicator())
                    : _error != null
                        ? Center(
                            child: Padding(
                                padding: const EdgeInsets.all(GremionTokens.s4),
                                child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(
                                        _error!.length > 200
                                            ? '${_error!.substring(0, 200)}…'
                                            : _error!,
                                        style: TextStyle(
                                            color: dark
                                                ? GremionTokens.rustDark
                                                : GremionTokens.rust),
                                        textAlign: TextAlign.center,
                                      ),
                                      const SizedBox(height: GremionTokens.s2),
                                      TextButton(
                                          onPressed: _load,
                                          child: const Text('Erneut laden')),
                                    ])))
                        : _files.isEmpty
                            ? Center(
                                child: Text('Ordner ist leer.',
                                    style:
                                        TextStyle(fontSize: 13, color: muted)))
                            : RefreshIndicator(
                                onRefresh: _load,
                                child: ListView.separated(
                                  itemCount: _files.length,
                                  separatorBuilder: (_, __) => Divider(
                                      height: 1,
                                      color: Theme.of(context).dividerColor),
                                  itemBuilder: (ctx, i) {
                                    final f = _files[i];
                                    return NcFileTile(
                                      file: f,
                                      onDelete: canWrite && !f.isDir
                                          ? () => _delete(f)
                                          : null,
                                      onTap: () {
                                        if (f.isDir) {
                                          setState(() => _path = f.path);
                                          _load();
                                        } else {
                                          Navigator.push<void>(
                                              context,
                                              MaterialPageRoute<void>(
                                                  builder: (_) =>
                                                      FileViewerScreen(
                                                          file: f)));
                                        }
                                      },
                                    );
                                  },
                                ),
                              ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Future<String?> _promptText(BuildContext context, String hint) async {
  final ctrl = TextEditingController();
  return showDialog<String>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
            title: Text(hint),
            content: TextField(controller: ctrl, autofocus: true),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(dialogCtx),
                  child: const Text('Abbrechen')),
              TextButton(
                  onPressed: () => Navigator.pop(dialogCtx, ctrl.text),
                  child: const Text('OK')),
            ],
          ));
}
