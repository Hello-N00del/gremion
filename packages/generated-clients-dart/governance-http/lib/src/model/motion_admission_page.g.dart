// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'motion_admission_page.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MotionAdmissionPage extends MotionAdmissionPage {
  @override
  final BuiltList<MotionAdmission> items;
  @override
  final String? nextCursor;

  factory _$MotionAdmissionPage(
          [void Function(MotionAdmissionPageBuilder)? updates]) =>
      (MotionAdmissionPageBuilder()..update(updates))._build();

  _$MotionAdmissionPage._({required this.items, this.nextCursor}) : super._();
  @override
  MotionAdmissionPage rebuild(
          void Function(MotionAdmissionPageBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MotionAdmissionPageBuilder toBuilder() =>
      MotionAdmissionPageBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MotionAdmissionPage &&
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
    return (newBuiltValueToStringHelper(r'MotionAdmissionPage')
          ..add('items', items)
          ..add('nextCursor', nextCursor))
        .toString();
  }
}

class MotionAdmissionPageBuilder
    implements Builder<MotionAdmissionPage, MotionAdmissionPageBuilder> {
  _$MotionAdmissionPage? _$v;

  ListBuilder<MotionAdmission>? _items;
  ListBuilder<MotionAdmission> get items =>
      _$this._items ??= ListBuilder<MotionAdmission>();
  set items(ListBuilder<MotionAdmission>? items) => _$this._items = items;

  String? _nextCursor;
  String? get nextCursor => _$this._nextCursor;
  set nextCursor(String? nextCursor) => _$this._nextCursor = nextCursor;

  MotionAdmissionPageBuilder() {
    MotionAdmissionPage._defaults(this);
  }

  MotionAdmissionPageBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _items = $v.items.toBuilder();
      _nextCursor = $v.nextCursor;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MotionAdmissionPage other) {
    _$v = other as _$MotionAdmissionPage;
  }

  @override
  void update(void Function(MotionAdmissionPageBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MotionAdmissionPage build() => _build();

  _$MotionAdmissionPage _build() {
    _$MotionAdmissionPage _$result;
    try {
      _$result = _$v ??
          _$MotionAdmissionPage._(
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
            r'MotionAdmissionPage', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
