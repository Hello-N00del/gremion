// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_members_post201_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdMembersPost201Response
    extends ApiGovernanceCommitteesIdMembersPost201Response {
  @override
  final bool success;
  @override
  final ApiGovernanceCommitteesIdDelete207ResponseData data;

  factory _$ApiGovernanceCommitteesIdMembersPost201Response(
          [void Function(
                  ApiGovernanceCommitteesIdMembersPost201ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdMembersPost201ResponseBuilder()
            ..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdMembersPost201Response._(
      {required this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdMembersPost201Response rebuild(
          void Function(ApiGovernanceCommitteesIdMembersPost201ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdMembersPost201ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdMembersPost201ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdMembersPost201Response &&
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
            r'ApiGovernanceCommitteesIdMembersPost201Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdMembersPost201ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdMembersPost201Response,
            ApiGovernanceCommitteesIdMembersPost201ResponseBuilder> {
  _$ApiGovernanceCommitteesIdMembersPost201Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  ApiGovernanceCommitteesIdDelete207ResponseDataBuilder? _data;
  ApiGovernanceCommitteesIdDelete207ResponseDataBuilder get data =>
      _$this._data ??= ApiGovernanceCommitteesIdDelete207ResponseDataBuilder();
  set data(ApiGovernanceCommitteesIdDelete207ResponseDataBuilder? data) =>
      _$this._data = data;

  ApiGovernanceCommitteesIdMembersPost201ResponseBuilder() {
    ApiGovernanceCommitteesIdMembersPost201Response._defaults(this);
  }

  ApiGovernanceCommitteesIdMembersPost201ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdMembersPost201Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdMembersPost201Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdMembersPost201ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdMembersPost201Response build() => _build();

  _$ApiGovernanceCommitteesIdMembersPost201Response _build() {
    _$ApiGovernanceCommitteesIdMembersPost201Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdMembersPost201Response._(
            success: BuiltValueNullFieldError.checkNotNull(success,
                r'ApiGovernanceCommitteesIdMembersPost201Response', 'success'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdMembersPost201Response',
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
