class NcFile {
  final String path;
  final String name;
  final bool isDir;
  final bool isLocked;
  final String etag;
  final int size;
  final DateTime lastModified;

  const NcFile({
    required this.path,
    required this.name,
    required this.isDir,
    required this.isLocked,
    required this.etag,
    required this.size,
    required this.lastModified,
  });

  /// Constructs an [NcFile] from a parsed WebDAV PROPFIND response.
  /// Called by the files service after parsing the XML response into named fields.
  /// The named-parameter shape matches PROPFIND property names (path, displayname,
  /// getlastmodified, getcontentlength, lockdiscovery, getetag).
  factory NcFile.fromWebDav({
    required String path,
    required String name,
    required bool isDir,
    required bool isLocked,
    required String etag,
    required int size,
    required DateTime lastModified,
  }) =>
      NcFile(
        path: path,
        name: name,
        isDir: isDir,
        isLocked: isLocked,
        etag: etag,
        size: size,
        lastModified: lastModified,
      );
}
