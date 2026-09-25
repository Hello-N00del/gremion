class GroupMember {
  final String id;
  final String username;
  final String displayName;

  const GroupMember(
      {required this.id, required this.username, required this.displayName});

  factory GroupMember.fromJson(Map<String, dynamic> j) => GroupMember(
        id: (j['id'] ?? '') as String,
        username: (j['username'] ?? '') as String,
        displayName: (j['displayName'] ?? j['username'] ?? '') as String,
      );
}

class Group {
  final String id;
  final String name;
  final List<GroupMember> members;
  final String? matrixRoomId;
  final String? ncFolderPath;

  const Group({
    required this.id,
    required this.name,
    required this.members,
    this.matrixRoomId,
    this.ncFolderPath,
  });

  factory Group.fromJson(Map<String, dynamic> j) => Group(
        id: j['id'] as String,
        name: j['name'] as String,
        members: j['members'] != null
            ? (j['members'] as List)
                .map((m) => GroupMember.fromJson(m as Map<String, dynamic>))
                .toList()
            : [],
        matrixRoomId: j['matrix_room_id'] as String?,
        ncFolderPath: j['nc_folder_path'] as String?,
      );
}
