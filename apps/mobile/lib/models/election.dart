enum ElectionStatus { pending, active, closed }

enum ElectionType { poll, helios }

class Election {
  final String id;
  final String title;
  final ElectionStatus status;
  final ElectionType type;

  /// Ballots cast so far. Null when the backend does not surface turnout
  /// (e.g. Helios while voting is open and tallies are sealed) — the UI then
  /// renders a "Beteiligung —" empty state rather than faking a figure.
  final int? castVotes;

  /// Eligible voters for this election, when known (null otherwise).
  final int? eligibleVoters;

  const Election({
    required this.id,
    required this.title,
    required this.status,
    required this.type,
    this.castVotes,
    this.eligibleVoters,
  });

  /// Turnout fraction in [0,1], or null when cast/eligible aren't both known.
  double? get turnout {
    final c = castVotes, e = eligibleVoters;
    if (c == null || e == null || e <= 0) return null;
    return (c / e).clamp(0.0, 1.0);
  }

  factory Election.fromJson(Map<String, dynamic> j) {
    final type = j['type'] == 'poll' ? ElectionType.poll : ElectionType.helios;
    final isClosed =
        (j['isClosed'] as bool?) ?? (j['isExpired'] as bool?) ?? false;
    final startsAt = j['votingStartsAt'] as String?;
    final endsAt = j['votingEndsAt'] as String?;
    final now = DateTime.now();
    final ElectionStatus status;
    if (isClosed) {
      status = ElectionStatus.closed;
    } else if (startsAt != null && endsAt != null) {
      final start = DateTime.tryParse(startsAt);
      final end = DateTime.tryParse(endsAt);
      if (start != null &&
          end != null &&
          now.isAfter(start) &&
          now.isBefore(end)) {
        status = ElectionStatus.active;
      } else {
        status = ElectionStatus.pending;
      }
    } else {
      status = type == ElectionType.poll
          ? ElectionStatus.active
          : ElectionStatus.pending;
    }
    int? asInt(Object? v) => v is int ? v : (v is num ? v.toInt() : null);
    return Election(
      id: (j['uuid'] ?? j['id']).toString(),
      title: (j['name'] ?? j['title'] ?? '') as String,
      status: status,
      type: type,
      castVotes: asInt(j['castVotes'] ?? j['cast'] ?? j['votesCast']),
      eligibleVoters:
          asInt(j['votersCount'] ?? j['eligible'] ?? j['eligibleVoters']),
    );
  }
}
