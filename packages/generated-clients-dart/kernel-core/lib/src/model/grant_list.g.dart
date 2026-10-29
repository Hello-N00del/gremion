// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'grant_list.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$GrantList extends GrantList {
  @override
  final BuiltList<Grant> grants;

  factory _$GrantList([void Function(GrantListBuilder)? updates]) =>
      (GrantListBuilder()..update(updates))._build();

  _$GrantList._({required this.grants}) : super._();
  @override
  GrantList rebuild(void Function(GrantListBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  GrantListBuilder toBuilder() => GrantListBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is GrantList && grants == other.grants;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, grants.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'GrantList')..add('grants', grants))
        .toString();
  }
}

class GrantListBuilder implements Builder<GrantList, GrantListBuilder> {
  _$GrantList? _$v;

  ListBuilder<Grant>? _grants;
  ListBuilder<Grant> get grants => _$this._grants ??= ListBuilder<Grant>();
  set grants(ListBuilder<Grant>? grants) => _$this._grants = grants;

  GrantListBuilder() {
    GrantList._defaults(this);
  }

  GrantListBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _grants = $v.grants.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(GrantList other) {
    _$v = other as _$GrantList;
  }

  @override
  void update(void Function(GrantListBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  GrantList build() => _build();

  _$GrantList _build() {
    _$GrantList _$result;
    try {
      _$result = _$v ??
          _$GrantList._(
            grants: grants.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'grants';
        grants.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'GrantList', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
