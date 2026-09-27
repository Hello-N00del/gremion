// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_patch200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdPatch200Response
    extends ApiGovernanceCommitteesIdPatch200Response {
  @override
  final bool success;
  @override
  final OrgUnit data;

  factory _$ApiGovernanceCommitteesIdPatch200Response(
          [void Function(ApiGovernanceCommitteesIdPatch200ResponseBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdPatch200ResponseBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdPatch200Response._(
      {required this.success, required this.data})
      : super._();
  @override
  ApiGovernanceCommitteesIdPatch200Response rebuild(
          void Function(ApiGovernanceCommitteesIdPatch200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdPatch200ResponseBuilder toBuilder() =>
      ApiGovernanceCommitteesIdPatch200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdPatch200Response &&
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
            r'ApiGovernanceCommitteesIdPatch200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGovernanceCommitteesIdPatch200ResponseBuilder
    implements
        Builder<ApiGovernanceCommitteesIdPatch200Response,
            ApiGovernanceCommitteesIdPatch200ResponseBuilder> {
  _$ApiGovernanceCommitteesIdPatch200Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  OrgUnitBuilder? _data;
  OrgUnitBuilder get data => _$this._data ??= OrgUnitBuilder();
  set data(OrgUnitBuilder? data) => _$this._data = data;

  ApiGovernanceCommitteesIdPatch200ResponseBuilder() {
    ApiGovernanceCommitteesIdPatch200Response._defaults(this);
  }

  ApiGovernanceCommitteesIdPatch200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdPatch200Response other) {
    _$v = other as _$ApiGovernanceCommitteesIdPatch200Response;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdPatch200ResponseBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdPatch200Response build() => _build();

  _$ApiGovernanceCommitteesIdPatch200Response _build() {
    _$ApiGovernanceCommitteesIdPatch200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdPatch200Response._(
            success: BuiltValueNullFieldError.checkNotNull(success,
                r'ApiGovernanceCommitteesIdPatch200Response', 'success'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdPatch200Response',
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
