// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_delete200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdDelete200Response
    extends ApiGovernanceCommitteesIdDelete200Response {
  @override
  final bool success;
  @override
  final JsonObject? data;

  factory _$ApiGovernanceCommitteesIdDelete200Response(
          [void Function(ApiGovernanceCommitteesIdDelete200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdDelete200ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdDelete200Response._(
      {required this.success, this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdDelete200Response rebuild(
          void Function(ApiGovernanceCommitteesIdDelete200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdDelete200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdDelete200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdDelete200Response &&
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
            r'ApiGovernanceCommitteesIdDelete200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdDelete200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdDelete200Response,
            ApiGovernanceCommitteesIdDelete200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdDelete200Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  JsonObject? _data;
  JsonObject? get data => _$this._data;
  set data(JsonObject? data) => _$this._data = data;

  ApiGovernanceCommitteesIdDelete200ResponseBuilder() {
    ApiGovernanceCommitteesIdDelete200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdDelete200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdDelete200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdDelete200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdDelete200ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdDelete200Response build() => _build();

  _$ApiGovernanceCommitteesIdDelete200Response _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesIdDelete200Response._(
          success: BuiltValueNullFieldError.checkNotNull(success,
              r'ApiGovernanceCommitteesIdDelete200Response', 'success'),
          data: data,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
