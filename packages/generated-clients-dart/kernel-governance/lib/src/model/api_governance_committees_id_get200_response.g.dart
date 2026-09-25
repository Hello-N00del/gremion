// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdGet200Response
    extends ApiGovernanceCommitteesIdGet200Response {
  @override
  final JsonObject? success;
  @override
  final BuiltMap<String, JsonObject?> data;

  factory _$ApiGovernanceCommitteesIdGet200Response(
          [void Function(ApiGovernanceCommitteesIdGet200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdGet200ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdGet200Response._(
      {this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdGet200Response rebuild(
          void Function(ApiGovernanceCommitteesIdGet200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdGet200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdGet200Response &&
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
            r'ApiGovernanceCommitteesIdGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdGet200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdGet200Response,
            ApiGovernanceCommitteesIdGet200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdGet200Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  MapBuilder<String, JsonObject?>? _data;
  MapBuilder<String, JsonObject?> get data =>
      _$this._data ??= MapBuilder<String, JsonObject?>();
  set data(MapBuilder<String, JsonObject?>? data) => _$this._data = data;

  ApiGovernanceCommitteesIdGet200ResponseBuilder() {
    ApiGovernanceCommitteesIdGet200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdGet200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdGet200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdGet200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdGet200Response build() => _build();

  _$ApiGovernanceCommitteesIdGet200Response _build() {
    _$ApiGovernanceCommitteesIdGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdGet200Response._(
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
            r'ApiGovernanceCommitteesIdGet200Response',
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
