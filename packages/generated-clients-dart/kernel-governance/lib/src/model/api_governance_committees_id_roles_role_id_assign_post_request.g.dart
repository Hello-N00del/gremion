// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_roles_role_id_assign_post_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest
    extends ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest {
  @override
  final String userKeycloakId;
  @override
  final Date startDate;
  @override
  final Date endDate;
  @override
  final String? heliosElectionId;

  factory _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest(
          [void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder()
            ..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest._(
      {required this.userKeycloakId,
      required this.startDate,
      required this.endDate,
      this.heliosElectionId})
      : super._();
  @override
  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest rebuild(
          void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder toBuilder() =>
      ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder()
        ..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest &&
        userKeycloakId == other.userKeycloakId &&
        startDate == other.startDate &&
        endDate == other.endDate &&
        heliosElectionId == other.heliosElectionId;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, userKeycloakId.hashCode);
    _$hash = $jc(_$hash, startDate.hashCode);
    _$hash = $jc(_$hash, endDate.hashCode);
    _$hash = $jc(_$hash, heliosElectionId.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest')
          ..add('userKeycloakId', userKeycloakId)
          ..add('startDate', startDate)
          ..add('endDate', endDate)
          ..add('heliosElectionId', heliosElectionId))
        .toString();
  }
}

class ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder
    implements
        Builder<ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest,
            ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder> {
  _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest? _$v;

  String? _userKeycloakId;
  String? get userKeycloakId => _$this._userKeycloakId;
  set userKeycloakId(String? userKeycloakId) =>
      _$this._userKeycloakId = userKeycloakId;

  Date? _startDate;
  Date? get startDate => _$this._startDate;
  set startDate(Date? startDate) => _$this._startDate = startDate;

  Date? _endDate;
  Date? get endDate => _$this._endDate;
  set endDate(Date? endDate) => _$this._endDate = endDate;

  String? _heliosElectionId;
  String? get heliosElectionId => _$this._heliosElectionId;
  set heliosElectionId(String? heliosElectionId) =>
      _$this._heliosElectionId = heliosElectionId;

  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder() {
    ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest._defaults(this);
  }

  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _userKeycloakId = $v.userKeycloakId;
      _startDate = $v.startDate;
      _endDate = $v.endDate;
      _heliosElectionId = $v.heliosElectionId;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest other) {
    _$v = other as _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest;
  }

  @override
  void update(
      void Function(
              ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest build() => _build();

  _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest._(
          userKeycloakId: BuiltValueNullFieldError.checkNotNull(
              userKeycloakId,
              r'ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest',
              'userKeycloakId'),
          startDate: BuiltValueNullFieldError.checkNotNull(
              startDate,
              r'ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest',
              'startDate'),
          endDate: BuiltValueNullFieldError.checkNotNull(
              endDate,
              r'ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest',
              'endDate'),
          heliosElectionId: heliosElectionId,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
