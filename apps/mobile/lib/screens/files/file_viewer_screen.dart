import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import '../../models/nc_file.dart';
import '../../services/api_client.dart';
import '../../tokens/app_tokens.dart';
import 'file_versions_screen.dart';

/// G-049: Sanitize a server-controlled filename before writing it under
/// [getTemporaryDirectory]. A malicious or compromised Nextcloud could
/// otherwise send `../../../../data/data/com.stura.app/shared_prefs/foo.xml`
/// (Android private-data overwrite) or names containing null bytes /
/// excessive length. Order matters:
///   1. Strip null bytes + ASCII control chars first.
///   2. Take the basename only (drops any directory components).
///   3. Reject literal `..` / `.` / empty.
///   4. Cap at 200 chars, preserving the extension when possible.
@visibleForTesting
String safeFilename(String raw) {
  var name = raw.replaceAll(RegExp(r'[\x00-\x1f]'), '');
  name = p.basename(name);
  if (name == '..' || name == '.' || name.isEmpty) {
    name = 'untitled';
  }
  if (name.length > 200) {
    final ext = p.extension(name);
    final stem = p.basenameWithoutExtension(name);
    final maxStem = (200 - ext.length).clamp(0, 200);
    name = '${stem.substring(0, maxStem)}$ext';
  }
  return name;
}

class FileViewerScreen extends StatefulWidget {
  const FileViewerScreen({required this.file, super.key});
  final NcFile file;
  @override
  State<FileViewerScreen> createState() => _FileViewerScreenState();
}

class _FileViewerScreenState extends State<FileViewerScreen> {
  bool _loading = true;
  File? _localFile;
  String? _error;
  String? _textContent;

  @override
  void initState() {
    super.initState();
    _download();
  }

  @override
  void dispose() {
    // #261: delete the previewed file from the temp dir when the viewer
    // closes, so downloaded council documents don't persist unencrypted in
    // the cache (surviving logout/session expiry otherwise). Best-effort,
    // fire-and-forget — the null-aware chain short-circuits when nothing was
    // written and .ignore() swallows any delete error.
    _localFile?.delete().ignore();
    super.dispose();
  }

  Future<void> _download() async {
    try {
      final bytes =
          await context.read<StuRaOSApiClient>().downloadFile(widget.file.path);
      final dir = await getTemporaryDirectory();

      // G-049: server-provided filename is untrusted. Strip any directory
      // components, reject traversal/null-byte tricks, cap length.
      final safeName = safeFilename(widget.file.name);
      final outPath = p.join(dir.path, safeName);

      // Defence in depth: refuse any final path that doesn't live directly
      // inside the temp dir (catches any p.basename edge case we missed).
      if (p.dirname(outPath) != dir.path) {
        throw StateError(
            'Sanitized path escaped temp dir: $outPath (parent ${p.dirname(outPath)} != ${dir.path})');
      }

      final f = File(outPath);
      await f.writeAsBytes(bytes);
      final ext = p.extension(safeName).replaceFirst('.', '').toLowerCase();
      String? textContent;
      if (ext == 'txt' || ext == 'md') {
        textContent = await f.readAsString();
      }
      if (mounted) {
        setState(() {
          _localFile = f;
          _textContent = textContent;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // A-008: use p.extension() (returns '' or '.ext') instead of split('.').last
    // which returned the whole name for extensionless files like 'README'.
    final ext =
        p.extension(widget.file.name).replaceFirst('.', '').toLowerCase();
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.file.name),
        actions: [
          IconButton(
            icon: const Icon(Icons.history),
            // G-090: explicit type args for strict-inference.
            onPressed: () => Navigator.push<void>(
                context,
                MaterialPageRoute<void>(
                    builder: (_) => FileVersionsScreen(file: widget.file))),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Text(_error!,
                      style: AppTextStyles.of(context)
                          .body
                          .copyWith(color: AppColors.of(context).danger)))
              : _buildPreview(ext),
    );
  }

  Widget _buildPreview(String ext) {
    final colors = AppColors.of(context);
    final text = AppTextStyles.of(context);
    if (_localFile == null) return const SizedBox();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].contains(ext)) {
      return InteractiveViewer(child: Center(child: Image.file(_localFile!)));
    }
    if (ext == 'txt' || ext == 'md') {
      return SingleChildScrollView(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Text(_textContent ?? '', style: text.body),
      );
    }
    return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
      Icon(Icons.insert_drive_file_outlined, size: 64, color: colors.textMuted),
      const SizedBox(height: AppSpacing.md),
      Text(widget.file.name, style: text.body),
      const SizedBox(height: AppSpacing.sm),
      Text('Keine Vorschau für .$ext-Dateien verfügbar', style: text.bodyMuted),
    ]));
  }
}
