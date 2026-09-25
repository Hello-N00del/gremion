// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_delete207_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdDelete207Response
    extends ApiGovernanceCommitteesIdDelete207Response {
  @override
  final JsonObject? success;
  @override
  final String error;
  @override
  final ApiGovernanceCommitteesIdDelete207ResponseData data;

  factory _$ApiGovernanceCommitteesIdDelete207Response(
          [void Function(ApiGovernanceCommitteesIdDelete207ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdDelete207ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdDelete207Response._(
      {this.success, required this.error, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdDelete207Response rebuild(
          void Function(ApiGovernanceCommitteesIdDelete207ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdDelete207ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdDelete207ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdDelete207Response &&
        success == other.success &&
        error == other.error &&
        data == other.data;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, success.hashCode);
    _$hash = $jc(_$hash, error.hashCode);
    _$hash = $jc(_$hash, data.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdDelete207Response')
          ..add('success', success)
          ..add('error', error)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdDelete207ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdDelete207Response,
            ApiGovernanceCommitteesIdDelete207ResponseBuilder> {
  _$ApiGovernanceCommitteesIdDelete207Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  String? _error;
  String? get error => _$this._error;
  set error(String? error) => _$this._error = error;

  ApiGovernanceCommitteesIdDelete207ResponseDataBuilder? _data;
  ApiGovernanceCommitteesIdDelete207ResponseDataBuilder get data =>
      _$this._data ??= ApiGovernanceCommitteesIdDelete207ResponseDataBuilder();
  set data(ApiGovernanceCommitteesIdDelete207ResponseDataBuilder? data) =>
      _$this._data = data;

  ApiGovernanceCommitteesIdDelete207ResponseBuilder() {
    ApiGovernanceCommitteesIdDelete207Response._defaults(this);
  }

  ApiGovernanceCommitteesIdDelete207ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _error = $v.error;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdDelete207Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdDelete207Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdDelete207ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdDelete207Response build() => _build();

  _$ApiGovernanceCommitteesIdDelete207Response _build() {
    _$ApiGovernanceCommitteesIdDelete207Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdDelete207Response._(
            success: success,
            error: BuiltValueNullFieldError.checkNotNull(
                error, r'ApiGovernanceCommitteesIdDelete207Response', 'error'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdDelete207Response',
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
