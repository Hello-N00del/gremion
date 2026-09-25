// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_members_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdMembersGet200Response
    extends ApiGovernanceCommitteesIdMembersGet200Response {
  @override
  final JsonObject? success;
  @override
  final BuiltList<CommitteeMember> data;

  factory _$ApiGovernanceCommitteesIdMembersGet200Response(
          [void Function(ApiGovernanceCommitteesIdMembersGet200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdMembersGet200ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdMembersGet200Response._(
      {this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdMembersGet200Response rebuild(
          void Function(ApiGovernanceCommitteesIdMembersGet200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdMembersGet200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdMembersGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdMembersGet200Response &&
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
            r'ApiGovernanceCommitteesIdMembersGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdMembersGet200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdMembersGet200Response,
            ApiGovernanceCommitteesIdMembersGet200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdMembersGet200Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  ListBuilder<CommitteeMember>? _data;
  ListBuilder<CommitteeMember> get data =>
      _$this._data ??= ListBuilder<CommitteeMember>();
  set data(ListBuilder<CommitteeMember>? data) => _$this._data = data;

  ApiGovernanceCommitteesIdMembersGet200ResponseBuilder() {
    ApiGovernanceCommitteesIdMembersGet200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdMembersGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdMembersGet200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdMembersGet200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdMembersGet200ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdMembersGet200Response build() => _build();

  _$ApiGovernanceCommitteesIdMembersGet200Response _build() {
    _$ApiGovernanceCommitteesIdMembersGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdMembersGet200Response._(
            success: success,
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdMembersGet200Response',
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
