class NcFileVersion {
  final String versionId;
  final DateTime modified;
  final int size;

  const NcFileVersion({
    required this.versionId,
    required this.modified,
    required this.size,
  });

  factory NcFileVersion.fromJson(Map<String, dynamic> j) => NcFileVersion(
        versionId: j['version_id'] as String,
        modified: DateTime.parse(j['modified'] as String),
        size: j['size'] as int,
      );
}
