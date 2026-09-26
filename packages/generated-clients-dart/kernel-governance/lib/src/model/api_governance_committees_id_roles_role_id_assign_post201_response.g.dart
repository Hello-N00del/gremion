// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_roles_role_id_assign_post201_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response
    extends ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response {
  @override
  final bool success;
  @override
  final RoleAssignment data;

  factory _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response(
          [void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder()
            ..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response._(
      {required this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response rebuild(
          void Function(
                  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder
      toBuilder() =>
          ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder()
            ..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response &&
        success == other.success &&
        data == other.data;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, success.hashCode);
    _$hash = $jc(_$hash, data.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response,
            ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder> {
  _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  RoleAssignmentBuilder? _data;
  RoleAssignmentBuilder get data => _$this._data ??= RoleAssignmentBuilder();
  set data(RoleAssignmentBuilder? data) => _$this._data = data;

  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder() {
    ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response._defaults(this);
  }

  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(
      ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response;
  }

  @override
  void update(
      void Function(
              ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response build() => _build();

  _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response _build() {
    _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response._(
            success: BuiltValueNullFieldError.checkNotNull(
                success,
                r'ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response',
                'success'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response',
            _$failedField,
            e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
