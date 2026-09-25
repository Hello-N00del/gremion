// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesGet200Response
    extends ApiGovernanceCommitteesGet200Response {
  @override
  final JsonObject? success;
  @override
  final BuiltList<OrgUnit> data;

  factory _$ApiGovernanceCommitteesGet200Response(
          [void Function(ApiGovernanceCommitteesGet200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesGet200ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesGet200Response._({this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesGet200Response rebuild(
          void Function(ApiGovernanceCommitteesGet200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesGet200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesGet200Response &&
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
            r'ApiGovernanceCommitteesGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesGet200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesGet200Response,
            ApiGovernanceCommitteesGet200ResponseBuilder> {
  _$ApiGovernanceCommitteesGet200Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  ListBuilder<OrgUnit>? _data;
  ListBuilder<OrgUnit> get data => _$this._data ??= ListBuilder<OrgUnit>();
  set data(ListBuilder<OrgUnit>? data) => _$this._data = data;

  ApiGovernanceCommitteesGet200ResponseBuilder() {
    ApiGovernanceCommitteesGet200Response._defaults(this);
  }

  ApiGovernanceCommitteesGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesGet200Response other) {
    _$v = other as _$ApiGovernanceCommitteesGet200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesGet200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesGet200Response build() => _build();

  _$ApiGovernanceCommitteesGet200Response _build() {
    _$ApiGovernanceCommitteesGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesGet200Response._(
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
            r'ApiGovernanceCommitteesGet200Response',
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
