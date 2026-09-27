// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'meeting_page.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MeetingPage extends MeetingPage {
  @override
  final BuiltList<Meeting> items;
  @override
  final String? nextCursor;

  factory _$MeetingPage([void Function(MeetingPageBuilder)? updates]) =>
      (MeetingPageBuilder()..update(updates))._build();

  _$MeetingPage._({required this.items, this.nextCursor}) : super._();
  @override
  MeetingPage rebuild(void Function(MeetingPageBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MeetingPageBuilder toBuilder() => MeetingPageBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MeetingPage &&
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
    return (newBuiltValueToStringHelper(r'MeetingPage')
          ..add('items', items)
          ..add('nextCursor', nextCursor))
        .toString();
  }
}

class MeetingPageBuilder implements Builder<MeetingPage, MeetingPageBuilder> {
  _$MeetingPage? _$v;

  ListBuilder<Meeting>? _items;
  ListBuilder<Meeting> get items => _$this._items ??= ListBuilder<Meeting>();
  set items(ListBuilder<Meeting>? items) => _$this._items = items;

  String? _nextCursor;
  String? get nextCursor => _$this._nextCursor;
  set nextCursor(String? nextCursor) => _$this._nextCursor = nextCursor;

  MeetingPageBuilder() {
    MeetingPage._defaults(this);
  }

  MeetingPageBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _items = $v.items.toBuilder();
      _nextCursor = $v.nextCursor;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MeetingPage other) {
    _$v = other as _$MeetingPage;
  }

  @override
  void update(void Function(MeetingPageBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MeetingPage build() => _build();

  _$MeetingPage _build() {
    _$MeetingPage _$result;
    try {
      _$result = _$v ??
          _$MeetingPage._(
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
            r'MeetingPage', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
