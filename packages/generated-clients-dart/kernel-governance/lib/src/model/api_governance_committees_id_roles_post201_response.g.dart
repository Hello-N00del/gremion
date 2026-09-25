// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_roles_post201_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdRolesPost201Response
    extends ApiGovernanceCommitteesIdRolesPost201Response {
  @override
  final bool success;
  @override
  final CommitteeRole data;

  factory _$ApiGovernanceCommitteesIdRolesPost201Response(
          [void Function(ApiGovernanceCommitteesIdRolesPost201ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdRolesPost201ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdRolesPost201Response._(
      {required this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdRolesPost201Response rebuild(
          void Function(ApiGovernanceCommitteesIdRolesPost201ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdRolesPost201ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdRolesPost201ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdRolesPost201Response &&
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
            r'ApiGovernanceCommitteesIdRolesPost201Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdRolesPost201ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdRolesPost201Response,
            ApiGovernanceCommitteesIdRolesPost201ResponseBuilder> {
  _$ApiGovernanceCommitteesIdRolesPost201Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  CommitteeRoleBuilder? _data;
  CommitteeRoleBuilder get data => _$this._data ??= CommitteeRoleBuilder();
  set data(CommitteeRoleBuilder? data) => _$this._data = data;

  ApiGovernanceCommitteesIdRolesPost201ResponseBuilder() {
    ApiGovernanceCommitteesIdRolesPost201Response._defaults(this);
  }

  ApiGovernanceCommitteesIdRolesPost201ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdRolesPost201Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdRolesPost201Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdRolesPost201ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdRolesPost201Response build() => _build();

  _$ApiGovernanceCommitteesIdRolesPost201Response _build() {
    _$ApiGovernanceCommitteesIdRolesPost201Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdRolesPost201Response._(
            success: BuiltValueNullFieldError.checkNotNull(success,
                r'ApiGovernanceCommitteesIdRolesPost201Response', 'success'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdRolesPost201Response',
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
