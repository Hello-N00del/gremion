// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'authz_decision_request_resource.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$AuthzDecisionRequestResource extends AuthzDecisionRequestResource {
  @override
  final String kind;
  @override
  final String id;

  factory _$AuthzDecisionRequestResource(
          [void Function(AuthzDecisionRequestResourceBuilder)? updates]) =>
      (AuthzDecisionRequestResourceBuilder()..update(updates))._build();

  _$AuthzDecisionRequestResource._({required this.kind, required this.id})
      : super._();
  @override
  AuthzDecisionRequestResource rebuild(
          void Function(AuthzDecisionRequestResourceBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AuthzDecisionRequestResourceBuilder toBuilder() =>
      AuthzDecisionRequestResourceBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AuthzDecisionRequestResource &&
        kind == other.kind &&
        id == other.id;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, kind.hashCode);
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AuthzDecisionRequestResource')
          ..add('kind', kind)
          ..add('id', id))
        .toString();
  }
}

class AuthzDecisionRequestResourceBuilder
    implements
        Builder<AuthzDecisionRequestResource,
            AuthzDecisionRequestResourceBuilder> {
  _$AuthzDecisionRequestResource? _$v;

  String? _kind;
  String? get kind => _$this._kind;
  set kind(String? kind) => _$this._kind = kind;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  AuthzDecisionRequestResourceBuilder() {
    AuthzDecisionRequestResource._defaults(this);
  }

  AuthzDecisionRequestResourceBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _kind = $v.kind;
      _id = $v.id;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AuthzDecisionRequestResource other) {
    _$v = other as _$AuthzDecisionRequestResource;
  }

  @override
  void update(void Function(AuthzDecisionRequestResourceBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AuthzDecisionRequestResource build() => _build();

  _$AuthzDecisionRequestResource _build() {
    final _$result = _$v ??
        _$AuthzDecisionRequestResource._(
          kind: BuiltValueNullFieldError.checkNotNull(
              kind, r'AuthzDecisionRequestResource', 'kind'),
          id: BuiltValueNullFieldError.checkNotNull(
              id, r'AuthzDecisionRequestResource', 'id'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
