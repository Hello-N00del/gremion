// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_post201_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesPost201Response
    extends ApiGovernanceCommitteesPost201Response {
  @override
  final JsonObject? success;
  @override
  final ApiGovernanceCommitteesPost201ResponseData data;

  factory _$ApiGovernanceCommitteesPost201Response(
          [void Function(ApiGovernanceCommitteesPost201ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesPost201ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesPost201Response._({this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesPost201Response rebuild(
          void Function(ApiGovernanceCommitteesPost201ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesPost201ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesPost201ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesPost201Response &&
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
            r'ApiGovernanceCommitteesPost201Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesPost201ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesPost201Response,
            ApiGovernanceCommitteesPost201ResponseBuilder> {
  _$ApiGovernanceCommitteesPost201Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  ApiGovernanceCommitteesPost201ResponseDataBuilder? _data;
  ApiGovernanceCommitteesPost201ResponseDataBuilder get data =>
      _$this._data ??= ApiGovernanceCommitteesPost201ResponseDataBuilder();
  set data(ApiGovernanceCommitteesPost201ResponseDataBuilder? data) =>
      _$this._data = data;

  ApiGovernanceCommitteesPost201ResponseBuilder() {
    ApiGovernanceCommitteesPost201Response._defaults(this);
  }

  ApiGovernanceCommitteesPost201ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesPost201Response other) {
    _$v = other as _$ApiGovernanceCommitteesPost201Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesPost201ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesPost201Response build() => _build();

  _$ApiGovernanceCommitteesPost201Response _build() {
    _$ApiGovernanceCommitteesPost201Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesPost201Response._(
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
            r'ApiGovernanceCommitteesPost201Response',
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
