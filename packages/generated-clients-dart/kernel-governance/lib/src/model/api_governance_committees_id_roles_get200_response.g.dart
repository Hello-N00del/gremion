// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_roles_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdRolesGet200Response
    extends ApiGovernanceCommitteesIdRolesGet200Response {
  @override
  final bool success;
  @override
  final BuiltList<BuiltMap<String, JsonObject?>> data;

  factory _$ApiGovernanceCommitteesIdRolesGet200Response(
          [void Function(ApiGovernanceCommitteesIdRolesGet200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdRolesGet200ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdRolesGet200Response._(
      {required this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdRolesGet200Response rebuild(
          void Function(ApiGovernanceCommitteesIdRolesGet200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdRolesGet200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdRolesGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdRolesGet200Response &&
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
            r'ApiGovernanceCommitteesIdRolesGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdRolesGet200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdRolesGet200Response,
            ApiGovernanceCommitteesIdRolesGet200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdRolesGet200Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  ListBuilder<BuiltMap<String, JsonObject?>>? _data;
  ListBuilder<BuiltMap<String, JsonObject?>> get data =>
      _$this._data ??= ListBuilder<BuiltMap<String, JsonObject?>>();
  set data(ListBuilder<BuiltMap<String, JsonObject?>>? data) =>
      _$this._data = data;

  ApiGovernanceCommitteesIdRolesGet200ResponseBuilder() {
    ApiGovernanceCommitteesIdRolesGet200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdRolesGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdRolesGet200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdRolesGet200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdRolesGet200ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdRolesGet200Response build() => _build();

  _$ApiGovernanceCommitteesIdRolesGet200Response _build() {
    _$ApiGovernanceCommitteesIdRolesGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdRolesGet200Response._(
            success: BuiltValueNullFieldError.checkNotNull(success,
                r'ApiGovernanceCommitteesIdRolesGet200Response', 'success'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdRolesGet200Response',
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
