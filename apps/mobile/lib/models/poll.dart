class PollOption {
  final String id;
  final String text;
  final int votes;
  const PollOption({required this.id, required this.text, required this.votes});
  factory PollOption.fromJson(Map<String, dynamic> j) => PollOption(
        id: (j['id'] ?? '').toString(),
        text: (j['text'] ?? j['pollOptionText'] ?? '') as String,
        votes: (j['votes'] as int?) ?? (j['countVotes'] as int?) ?? 0,
      );
}

class Poll {
  final String id;
  final String title;
  final List<PollOption> options;
  final DateTime deadline;
  final String groupId;
  final bool voted;

  const Poll({
    required this.id,
    required this.title,
    required this.options,
    required this.deadline,
    required this.groupId,
    required this.voted,
  });

  factory Poll.fromJson(Map<String, dynamic> j) => Poll(
        id: (j['id'] ?? '').toString(),
        title: (j['title'] ?? '') as String,
        options: j['options'] != null
            ? (j['options'] as List)
                .map((o) => o is String
                    ? PollOption(id: o, text: o, votes: 0)
                    : PollOption.fromJson(o as Map<String, dynamic>))
                .toList()
            : [],
        deadline: j['deadline'] != null
            ? DateTime.tryParse(j['deadline'] as String) ?? DateTime(2100)
            : ((j['isExpired'] as bool?) ?? false)
                ? DateTime(2000)
                : DateTime(2100),
        groupId: (j['group_id'] ?? '') as String,
        voted: (j['voted'] as bool?) ?? (j['hasVoted'] as bool?) ?? false,
      );
}
