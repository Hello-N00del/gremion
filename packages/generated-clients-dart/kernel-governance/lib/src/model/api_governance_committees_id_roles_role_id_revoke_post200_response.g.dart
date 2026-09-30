// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_roles_role_id_revoke_post200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response
    extends ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response {
  @override
  final bool success;
  @override
  final bool groupsReconciled;

  factory _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response(
          [void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder()
            ..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response._(
      {required this.success, required this.groupsReconciled})
      : super._();
  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response rebuild(
          void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder
      toBuilder() =>
          ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder()
            ..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response &&
        success == other.success &&
        groupsReconciled == other.groupsReconciled;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, success.hashCode);
    _$hash = $jc(_$hash, groupsReconciled.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response')
          ..add('success', success)
          ..add('groupsReconciled', groupsReconciled))
        .toString();
  }
}

class ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response,
            ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  bool? _groupsReconciled;
  bool? get groupsReconciled => _$this._groupsReconciled;
  set groupsReconciled(bool? groupsReconciled) =>
      _$this._groupsReconciled = groupsReconciled;

  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder() {
    ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _groupsReconciled = $v.groupsReconciled;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(
      ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response;
  }

  @override
  void update(
      void Function(
              ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response build() => _build();

  _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response._(
          success: BuiltValueNullFieldError.checkNotNull(
              success,
              r'ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response',
              'success'),
          groupsReconciled: BuiltValueNullFieldError.checkNotNull(
              groupsReconciled,
              r'ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response',
              'groupsReconciled'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
