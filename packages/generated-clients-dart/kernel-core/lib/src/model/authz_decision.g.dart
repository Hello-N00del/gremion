// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'authz_decision.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$AuthzDecision extends AuthzDecision {
  @override
  final bool allow;
  @override
  final String reason;
  @override
  final BuiltList<String> grantIds;

  factory _$AuthzDecision([void Function(AuthzDecisionBuilder)? updates]) =>
      (AuthzDecisionBuilder()..update(updates))._build();

  _$AuthzDecision._(
      {required this.allow, required this.reason, required this.grantIds})
      : super._();
  @override
  AuthzDecision rebuild(void Function(AuthzDecisionBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AuthzDecisionBuilder toBuilder() => AuthzDecisionBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AuthzDecision &&
        allow == other.allow &&
        reason == other.reason &&
        grantIds == other.grantIds;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, allow.hashCode);
    _$hash = $jc(_$hash, reason.hashCode);
    _$hash = $jc(_$hash, grantIds.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AuthzDecision')
          ..add('allow', allow)
          ..add('reason', reason)
          ..add('grantIds', grantIds))
        .toString();
  }
}

class AuthzDecisionBuilder
    implements Builder<AuthzDecision, AuthzDecisionBuilder> {
  _$AuthzDecision? _$v;

  bool? _allow;
  bool? get allow => _$this._allow;
  set allow(bool? allow) => _$this._allow = allow;

  String? _reason;
  String? get reason => _$this._reason;
  set reason(String? reason) => _$this._reason = reason;

  ListBuilder<String>? _grantIds;
  ListBuilder<String> get grantIds =>
      _$this._grantIds ??= ListBuilder<String>();
  set grantIds(ListBuilder<String>? grantIds) => _$this._grantIds = grantIds;

  AuthzDecisionBuilder() {
    AuthzDecision._defaults(this);
  }

  AuthzDecisionBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _allow = $v.allow;
      _reason = $v.reason;
      _grantIds = $v.grantIds.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AuthzDecision other) {
    _$v = other as _$AuthzDecision;
  }

  @override
  void update(void Function(AuthzDecisionBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AuthzDecision build() => _build();

  _$AuthzDecision _build() {
    _$AuthzDecision _$result;
    try {
      _$result = _$v ??
          _$AuthzDecision._(
            allow: BuiltValueNullFieldError.checkNotNull(
                allow, r'AuthzDecision', 'allow'),
            reason: BuiltValueNullFieldError.checkNotNull(
                reason, r'AuthzDecision', 'reason'),
            grantIds: grantIds.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'grantIds';
        grantIds.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'AuthzDecision', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
