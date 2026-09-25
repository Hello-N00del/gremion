// mobile/lib/widgets/nc_file_tile.dart
//
// Phase 5.4 (v5 mobile rebuild) — a Nextcloud file/folder row in the v5
// `m-file-row` look (mobile-app.jsx:158-168 / mobile.css:218-235): an
// extension-badge square (folder ▸ / file EXT), a name line, and a mono
// "MOD · SIZE" meta line. Delete/lock affordances are preserved.
import 'package:flutter/material.dart';
import '../models/nc_file.dart';
import '../tokens/design_tokens.dart';
import 'file_lock_badge.dart';

class NcFileTile extends StatelessWidget {
  const NcFileTile(
      {required this.file, required this.onTap, this.onDelete, super.key});
  final NcFile file;
  final VoidCallback onTap;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    final accentInk = dark ? GremionTokens.accentInkDark : GremionTokens.accentInk;

    final badgeBg = file.isDir
        ? (dark ? GremionTokens.accentSoftDark : GremionTokens.accentSoft)
        : (dark ? GremionTokens.surface2Dark : GremionTokens.surface2);
    final badgeFg = file.isDir ? accentInk : muted;

    return InkWell(
      onTap: file.isLocked ? null : onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
            horizontal: GremionTokens.s4, vertical: GremionTokens.s3),
        child: Row(
          children: [
            // Ext-badge square.
            Container(
              width: 36,
              height: 40,
              decoration:
                  BoxDecoration(color: badgeBg, borderRadius: GremionTokens.rXs),
              alignment: Alignment.center,
              child: Text(
                file.isDir ? '▸' : _ext(file.name),
                style: TextStyle(
                  fontFamily: GremionTokens.fontMono,
                  fontSize: file.isDir ? 13 : 9,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                  color: badgeFg,
                ),
              ),
            ),
            const SizedBox(width: GremionTokens.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    Flexible(
                      child: Text(file.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w500,
                              color: onSurface)),
                    ),
                    if (file.isLocked) ...[
                      const SizedBox(width: 6),
                      const FileLockBadge(),
                    ],
                  ]),
                  const SizedBox(height: 2),
                  Text(
                    _meta(),
                    style: TextStyle(
                        fontFamily: GremionTokens.fontMono,
                        fontSize: 10,
                        letterSpacing: 0.3,
                        color: muted),
                  ),
                ],
              ),
            ),
            if (onDelete != null)
              IconButton(
                icon: const Icon(Icons.delete_outline, size: 20),
                color: dark ? GremionTokens.rustDark : GremionTokens.rust,
                onPressed: onDelete,
              ),
          ],
        ),
      ),
    );
  }

  String _ext(String name) {
    final dot = name.lastIndexOf('.');
    if (dot <= 0 || dot == name.length - 1) return 'DAT';
    final ext = name.substring(dot + 1).toUpperCase();
    return ext.length > 4 ? ext.substring(0, 4) : ext;
  }

  String _meta() {
    final mod = _modLabel(file.lastModified);
    if (file.isDir) return mod.toUpperCase();
    return '${mod.toUpperCase()} · ${_formatSize(file.size)}';
  }

  String _modLabel(DateTime d) {
    final now = DateTime.now();
    final diff = now.difference(d);
    if (diff.inMinutes < 60) return 'vor ${diff.inMinutes} min';
    if (diff.inHours < 24) return 'vor ${diff.inHours} h';
    if (diff.inDays < 30) return 'vor ${diff.inDays} t';
    return '${d.day}.${d.month}.${d.year}';
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1048576) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1048576).toStringAsFixed(1)} MB';
  }
}
