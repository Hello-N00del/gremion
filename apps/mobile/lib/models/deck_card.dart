// mobile/lib/models/deck_card.dart
//
// Part G (Design v8) — Deck/Aufgaben models. Mirrors the web Deck contract
// served by gremion-ui (`$lib/server/board/board-db.ts`): a Board owns Stacks
// (columns), a Stack owns Cards. A card's status IS the stack it sits in.
//
// The live JSON is snake_case (Postgres rows passed straight through the
// SvelteKit JSON handler): board `{ id, org_unit_id, name, archived }`,
// stack `{ id, board_id, name, sort_order }`, card `{ id, stack_id, title,
// description, assignee_keycloak_id, due_date, label, sort_order, ... }`.

class Board {
  final String id;
  final String orgUnitId;
  final String name;
  final bool archived;

  const Board({
    required this.id,
    required this.orgUnitId,
    required this.name,
    this.archived = false,
  });

  factory Board.fromJson(Map<String, dynamic> j) => Board(
        id: j['id'].toString(),
        orgUnitId: (j['org_unit_id'] ?? '').toString(),
        name: (j['name'] ?? '') as String,
        archived: (j['archived'] as bool?) ?? false,
      );
}

class DeckStack {
  final String id;
  final String boardId;
  final String name;
  final int sortOrder;

  const DeckStack({
    required this.id,
    required this.boardId,
    required this.name,
    this.sortOrder = 0,
  });

  factory DeckStack.fromJson(Map<String, dynamic> j) => DeckStack(
        id: j['id'].toString(),
        boardId: (j['board_id'] ?? '').toString(),
        name: (j['name'] ?? '') as String,
        sortOrder: (j['sort_order'] as num?)?.toInt() ?? 0,
      );
}

class DeckCard {
  final String id;
  final String stackId;
  final String title;
  final String? description;

  /// Keycloak id of the assignee (matches the session `sub` claim). Used to
  /// count "Meine Aufgaben" on the Home screen.
  final String? assigneeKeycloakId;

  /// ISO date string (date-only, e.g. "2026-04-23"), or null.
  final String? dueDate;

  /// Bare label string (the board `Card.label` field is still singular per the
  /// carried-forward backend flag). The hue is derived from this string.
  final String? label;
  final int sortOrder;

  const DeckCard({
    required this.id,
    required this.stackId,
    required this.title,
    this.description,
    this.assigneeKeycloakId,
    this.dueDate,
    this.label,
    this.sortOrder = 0,
  });

  factory DeckCard.fromJson(Map<String, dynamic> j) => DeckCard(
        id: j['id'].toString(),
        stackId: (j['stack_id'] ?? '').toString(),
        title: (j['title'] ?? '') as String,
        description: j['description'] as String?,
        assigneeKeycloakId: j['assignee_keycloak_id'] as String?,
        dueDate: j['due_date'] as String?,
        label: j['label'] as String?,
        sortOrder: (j['sort_order'] as num?)?.toInt() ?? 0,
      );
}

/// One board's full deck — the shape returned by `GET /api/board/[id]`
/// (`{ data: { board, stacks, cards } }`).
class Deck {
  final Board board;
  final List<DeckStack> stacks;
  final List<DeckCard> cards;

  const Deck({required this.board, required this.stacks, required this.cards});

  factory Deck.fromJson(Map<String, dynamic> j) => Deck(
        board: Board.fromJson(j['board'] as Map<String, dynamic>),
        stacks: ((j['stacks'] as List?) ?? const [])
            .map((s) => DeckStack.fromJson(s as Map<String, dynamic>))
            .toList()
          ..sort((a, b) => a.sortOrder.compareTo(b.sortOrder)),
        cards: ((j['cards'] as List?) ?? const [])
            .map((c) => DeckCard.fromJson(c as Map<String, dynamic>))
            .toList()
          ..sort((a, b) => a.sortOrder.compareTo(b.sortOrder)),
      );

  /// Cards in [stackId], in sort order.
  List<DeckCard> cardsIn(String stackId) =>
      cards.where((c) => c.stackId == stackId).toList();
}
