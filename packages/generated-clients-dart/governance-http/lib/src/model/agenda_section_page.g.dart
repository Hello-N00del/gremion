// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agenda_section_page.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$AgendaSectionPage extends AgendaSectionPage {
  @override
  final BuiltList<AgendaSection> items;
  @override
  final String? nextCursor;

  factory _$AgendaSectionPage(
          [void Function(AgendaSectionPageBuilder)? updates]) =>
      (AgendaSectionPageBuilder()..update(updates))._build();

  _$AgendaSectionPage._({required this.items, this.nextCursor}) : super._();
  @override
  AgendaSectionPage rebuild(void Function(AgendaSectionPageBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AgendaSectionPageBuilder toBuilder() =>
      AgendaSectionPageBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AgendaSectionPage &&
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
    return (newBuiltValueToStringHelper(r'AgendaSectionPage')
          ..add('items', items)
          ..add('nextCursor', nextCursor))
        .toString();
  }
}

class AgendaSectionPageBuilder
    implements Builder<AgendaSectionPage, AgendaSectionPageBuilder> {
  _$AgendaSectionPage? _$v;

  ListBuilder<AgendaSection>? _items;
  ListBuilder<AgendaSection> get items =>
      _$this._items ??= ListBuilder<AgendaSection>();
  set items(ListBuilder<AgendaSection>? items) => _$this._items = items;

  String? _nextCursor;
  String? get nextCursor => _$this._nextCursor;
  set nextCursor(String? nextCursor) => _$this._nextCursor = nextCursor;

  AgendaSectionPageBuilder() {
    AgendaSectionPage._defaults(this);
  }

  AgendaSectionPageBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _items = $v.items.toBuilder();
      _nextCursor = $v.nextCursor;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AgendaSectionPage other) {
    _$v = other as _$AgendaSectionPage;
  }

  @override
  void update(void Function(AgendaSectionPageBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AgendaSectionPage build() => _build();

  _$AgendaSectionPage _build() {
    _$AgendaSectionPage _$result;
    try {
      _$result = _$v ??
          _$AgendaSectionPage._(
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
            r'AgendaSectionPage', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
