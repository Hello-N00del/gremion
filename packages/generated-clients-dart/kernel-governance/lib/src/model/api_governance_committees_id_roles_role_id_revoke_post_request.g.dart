// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_roles_role_id_revoke_post_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest
    extends ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest {
  @override
  final String reason;

  factory _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest(
          [void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder()
            ..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest._(
      {required this.reason})
      : super._();
  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest rebuild(
          void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder toBuilder() =>
      ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder()
        ..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest &&
        reason == other.reason;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, reason.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest')
          ..add('reason', reason))
        .toString();
  }
}

class ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder
    implements
        Builder<ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest,
            ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder> {
  _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest? _$v;

  String? _reason;
  String? get reason => _$this._reason;
  set reason(String? reason) => _$this._reason = reason;

  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder() {
    ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest._defaults(this);
  }

  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _reason = $v.reason;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest other) {
    _$v = other as _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest;
  }

  @override
  void update(
      void Function(
              ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest build() => _build();

  _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest._(
          reason: BuiltValueNullFieldError.checkNotNull(
              reason,
              r'ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest',
              'reason'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
