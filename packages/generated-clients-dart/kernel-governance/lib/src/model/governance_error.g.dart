// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'governance_error.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$GovernanceError extends GovernanceError {
  @override
  final bool success;
  @override
  final String error;

  factory _$GovernanceError([void Function(GovernanceErrorBuilder)? updates]) =>
      (GovernanceErrorBuilder()..update(updates))._build();

  _$GovernanceError._({required this.success, required this.error}) : super._();
  @override
  GovernanceError rebuild(void Function(GovernanceErrorBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  GovernanceErrorBuilder toBuilder() => GovernanceErrorBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is GovernanceError &&
        success == other.success &&
        error == other.error;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, success.hashCode);
    _$hash = $jc(_$hash, error.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'GovernanceError')
          ..add('success', success)
          ..add('error', error))
        .toString();
  }
}

class GovernanceErrorBuilder
    implements Builder<GovernanceError, GovernanceErrorBuilder> {
  _$GovernanceError? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  String? _error;
  String? get error => _$this._error;
  set error(String? error) => _$this._error = error;

  GovernanceErrorBuilder() {
    GovernanceError._defaults(this);
  }

  GovernanceErrorBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _error = $v.error;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(GovernanceError other) {
    _$v = other as _$GovernanceError;
  }

  @override
  void update(void Function(GovernanceErrorBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  GovernanceError build() => _build();

  _$GovernanceError _build() {
    final _$result = _$v ??
        _$GovernanceError._(
          success: BuiltValueNullFieldError.checkNotNull(
              success, r'GovernanceError', 'success'),
          error: BuiltValueNullFieldError.checkNotNull(
              error, r'GovernanceError', 'error'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
