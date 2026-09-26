// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agenda_item_page.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$AgendaItemPage extends AgendaItemPage {
  @override
  final BuiltList<AgendaItem> items;
  @override
  final String? nextCursor;

  factory _$AgendaItemPage([void Function(AgendaItemPageBuilder)? updates]) =>
      (AgendaItemPageBuilder()..update(updates))._build();

  _$AgendaItemPage._({required this.items, this.nextCursor}) : super._();
  @override
  AgendaItemPage rebuild(void Function(AgendaItemPageBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AgendaItemPageBuilder toBuilder() => AgendaItemPageBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AgendaItemPage &&
        items == other.items &&
        nextCursor == other.nextCursor;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, items.hashCode);
    _$hash = $jc(_$hash, nextCursor.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AgendaItemPage')
          ..add('items', items)
          ..add('nextCursor', nextCursor))
        .toString();
  }
}

class AgendaItemPageBuilder
    implements Builder<AgendaItemPage, AgendaItemPageBuilder> {
  _$AgendaItemPage? _$v;

  ListBuilder<AgendaItem>? _items;
  ListBuilder<AgendaItem> get items =>
      _$this._items ??= ListBuilder<AgendaItem>();
  set items(ListBuilder<AgendaItem>? items) => _$this._items = items;

  String? _nextCursor;
  String? get nextCursor => _$this._nextCursor;
  set nextCursor(String? nextCursor) => _$this._nextCursor = nextCursor;

  AgendaItemPageBuilder() {
    AgendaItemPage._defaults(this);
  }

  AgendaItemPageBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _items = $v.items.toBuilder();
      _nextCursor = $v.nextCursor;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AgendaItemPage other) {
    _$v = other as _$AgendaItemPage;
  }

  @override
  void update(void Function(AgendaItemPageBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AgendaItemPage build() => _build();

  _$AgendaItemPage _build() {
    _$AgendaItemPage _$result;
    try {
      _$result = _$v ??
          _$AgendaItemPage._(
            items: items.build(),
            nextCursor: nextCursor,
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'items';
        items.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'AgendaItemPage', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
