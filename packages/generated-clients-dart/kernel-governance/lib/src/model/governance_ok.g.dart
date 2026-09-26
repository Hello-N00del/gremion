// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'governance_ok.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$GovernanceOk extends GovernanceOk {
  @override
  final bool success;

  factory _$GovernanceOk([void Function(GovernanceOkBuilder)? updates]) =>
      (GovernanceOkBuilder()..update(updates))._build();

  _$GovernanceOk._({required this.success}) : super._();
  @override
  GovernanceOk rebuild(void Function(GovernanceOkBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  GovernanceOkBuilder toBuilder() => GovernanceOkBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is GovernanceOk && success == other.success;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, success.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'GovernanceOk')
          ..add('success', success))
        .toString();
  }
}

class GovernanceOkBuilder
    implements Builder<GovernanceOk, GovernanceOkBuilder> {
  _$GovernanceOk? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  GovernanceOkBuilder() {
    GovernanceOk._defaults(this);
  }

  GovernanceOkBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(GovernanceOk other) {
    _$v = other as _$GovernanceOk;
  }

  @override
  void update(void Function(GovernanceOkBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  GovernanceOk build() => _build();

  _$GovernanceOk _build() {
    final _$result = _$v ??
        _$GovernanceOk._(
          success: BuiltValueNullFieldError.checkNotNull(
              success, r'GovernanceOk', 'success'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
