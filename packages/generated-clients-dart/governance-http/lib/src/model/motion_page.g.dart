// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'motion_page.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MotionPage extends MotionPage {
  @override
  final BuiltList<Motion> items;
  @override
  final String? nextCursor;

  factory _$MotionPage([void Function(MotionPageBuilder)? updates]) =>
      (MotionPageBuilder()..update(updates))._build();

  _$MotionPage._({required this.items, this.nextCursor}) : super._();
  @override
  MotionPage rebuild(void Function(MotionPageBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MotionPageBuilder toBuilder() => MotionPageBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MotionPage &&
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
    return (newBuiltValueToStringHelper(r'MotionPage')
          ..add('items', items)
          ..add('nextCursor', nextCursor))
        .toString();
  }
}

class MotionPageBuilder implements Builder<MotionPage, MotionPageBuilder> {
  _$MotionPage? _$v;

  ListBuilder<Motion>? _items;
  ListBuilder<Motion> get items => _$this._items ??= ListBuilder<Motion>();
  set items(ListBuilder<Motion>? items) => _$this._items = items;

  String? _nextCursor;
  String? get nextCursor => _$this._nextCursor;
  set nextCursor(String? nextCursor) => _$this._nextCursor = nextCursor;

  MotionPageBuilder() {
    MotionPage._defaults(this);
  }

  MotionPageBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _items = $v.items.toBuilder();
      _nextCursor = $v.nextCursor;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MotionPage other) {
    _$v = other as _$MotionPage;
  }

  @override
  void update(void Function(MotionPageBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MotionPage build() => _build();

  _$MotionPage _build() {
    _$MotionPage _$result;
    try {
      _$result = _$v ??
          _$MotionPage._(
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
            r'MotionPage', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
