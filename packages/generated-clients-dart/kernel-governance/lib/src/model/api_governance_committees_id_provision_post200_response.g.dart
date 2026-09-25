// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_provision_post200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdProvisionPost200Response
    extends ApiGovernanceCommitteesIdProvisionPost200Response {
  @override
  final JsonObject? success;
  @override
  final ProvisioningReport data;

  factory _$ApiGovernanceCommitteesIdProvisionPost200Response(
          [void Function(
                  ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder()
            ..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdProvisionPost200Response._(
      {this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdProvisionPost200Response rebuild(
          void Function(
                  ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdProvisionPost200Response &&
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
            r'ApiGovernanceCommitteesIdProvisionPost200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdProvisionPost200Response,
            ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdProvisionPost200Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  ProvisioningReportBuilder? _data;
  ProvisioningReportBuilder get data =>
      _$this._data ??= ProvisioningReportBuilder();
  set data(ProvisioningReportBuilder? data) => _$this._data = data;

  ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder() {
    ApiGovernanceCommitteesIdProvisionPost200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdProvisionPost200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdProvisionPost200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdProvisionPost200Response build() => _build();

  _$ApiGovernanceCommitteesIdProvisionPost200Response _build() {
    _$ApiGovernanceCommitteesIdProvisionPost200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdProvisionPost200Response._(
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
            r'ApiGovernanceCommitteesIdProvisionPost200Response',
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
