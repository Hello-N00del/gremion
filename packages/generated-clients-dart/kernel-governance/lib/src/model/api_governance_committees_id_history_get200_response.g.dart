// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_history_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdHistoryGet200Response
    extends ApiGovernanceCommitteesIdHistoryGet200Response {
  @override
  final JsonObject? success;
  @override
  final BuiltList<RoleAssignmentHistoryEntry> data;

  factory _$ApiGovernanceCommitteesIdHistoryGet200Response(
          [void Function(ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdHistoryGet200Response._(
      {this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdHistoryGet200Response rebuild(
          void Function(ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdHistoryGet200Response &&
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
            r'ApiGovernanceCommitteesIdHistoryGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdHistoryGet200Response,
            ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdHistoryGet200Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  ListBuilder<RoleAssignmentHistoryEntry>? _data;
  ListBuilder<RoleAssignmentHistoryEntry> get data =>
      _$this._data ??= ListBuilder<RoleAssignmentHistoryEntry>();
  set data(ListBuilder<RoleAssignmentHistoryEntry>? data) =>
      _$this._data = data;

  ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder() {
    ApiGovernanceCommitteesIdHistoryGet200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdHistoryGet200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdHistoryGet200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdHistoryGet200Response build() => _build();

  _$ApiGovernanceCommitteesIdHistoryGet200Response _build() {
    _$ApiGovernanceCommitteesIdHistoryGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdHistoryGet200Response._(
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
            r'ApiGovernanceCommitteesIdHistoryGet200Response',
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
