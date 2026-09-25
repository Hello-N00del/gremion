class CalendarEvent {
  final String uid;
  final String title;
  final DateTime start;
  final DateTime end;
  final String? location;
  final String? description;

  const CalendarEvent({
    required this.uid,
    required this.title,
    required this.start,
    required this.end,
    this.location,
    this.description,
  });

  factory CalendarEvent.fromJson(Map<String, dynamic> j) => CalendarEvent(
        // #246: the gateway DbEvent envelope uses id/startAt/endAt. Keep a
        // legacy uid/start/end fallback so any older payload still parses.
        uid: (j['id'] ?? j['uid']) as String,
        title: j['title'] as String,
        start: DateTime.parse((j['startAt'] ?? j['start']) as String),
        end: DateTime.parse((j['endAt'] ?? j['end']) as String),
        location: j['location'] as String?,
        description: j['description'] as String?,
      );

  Map<String, dynamic> toJson() => {
        // #246: create/update schemas expect startAt/endAt; the id is
        // server-assigned (create) or carried in the URL (update), never in
        // the body — so it is intentionally omitted here.
        'title': title,
        'startAt': start.toIso8601String(),
        'endAt': end.toIso8601String(),
        if (location != null) 'location': location,
        if (description != null) 'description': description,
      };
}
