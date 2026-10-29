// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'authz_decision_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$AuthzDecisionRequest extends AuthzDecisionRequest {
  @override
  final String subject;
  @override
  final String bodyId;
  @override
  final String capability;
  @override
  final AuthzDecisionRequestResource? resource;

  factory _$AuthzDecisionRequest(
          [void Function(AuthzDecisionRequestBuilder)? updates]) =>
      (AuthzDecisionRequestBuilder()..update(updates))._build();

  _$AuthzDecisionRequest._(
      {required this.subject,
      required this.bodyId,
      required this.capability,
      this.resource})
      : super._();
  @override
  AuthzDecisionRequest rebuild(
          void Function(AuthzDecisionRequestBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AuthzDecisionRequestBuilder toBuilder() =>
      AuthzDecisionRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AuthzDecisionRequest &&
        subject == other.subject &&
        bodyId == other.bodyId &&
        capability == other.capability &&
        resource == other.resource;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, subject.hashCode);
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, capability.hashCode);
    _$hash = $jc(_$hash, resource.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AuthzDecisionRequest')
          ..add('subject', subject)
          ..add('bodyId', bodyId)
          ..add('capability', capability)
          ..add('resource', resource))
        .toString();
  }
}

class AuthzDecisionRequestBuilder
    implements Builder<AuthzDecisionRequest, AuthzDecisionRequestBuilder> {
  _$AuthzDecisionRequest? _$v;

  String? _subject;
  String? get subject => _$this._subject;
  set subject(String? subject) => _$this._subject = subject;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  String? _capability;
  String? get capability => _$this._capability;
  set capability(String? capability) => _$this._capability = capability;

  AuthzDecisionRequestResourceBuilder? _resource;
  AuthzDecisionRequestResourceBuilder get resource =>
      _$this._resource ??= AuthzDecisionRequestResourceBuilder();
  set resource(AuthzDecisionRequestResourceBuilder? resource) =>
      _$this._resource = resource;

  AuthzDecisionRequestBuilder() {
    AuthzDecisionRequest._defaults(this);
  }

  AuthzDecisionRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _subject = $v.subject;
      _bodyId = $v.bodyId;
      _capability = $v.capability;
      _resource = $v.resource?.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AuthzDecisionRequest other) {
    _$v = other as _$AuthzDecisionRequest;
  }

  @override
  void update(void Function(AuthzDecisionRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AuthzDecisionRequest build() => _build();

  _$AuthzDecisionRequest _build() {
    _$AuthzDecisionRequest _$result;
    try {
      _$result = _$v ??
          _$AuthzDecisionRequest._(
            subject: BuiltValueNullFieldError.checkNotNull(
                subject, r'AuthzDecisionRequest', 'subject'),
            bodyId: BuiltValueNullFieldError.checkNotNull(
                bodyId, r'AuthzDecisionRequest', 'bodyId'),
            capability: BuiltValueNullFieldError.checkNotNull(
                capability, r'AuthzDecisionRequest', 'capability'),
            resource: _resource?.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'resource';
        _resource?.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'AuthzDecisionRequest', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
