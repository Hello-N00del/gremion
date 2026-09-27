// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_groups_id_patch_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGroupsIdPatchRequest extends ApiGroupsIdPatchRequest {
  @override
  final String? name;

  factory _$ApiGroupsIdPatchRequest(
          [void Function(ApiGroupsIdPatchRequestBuilder)? updates]) =>
      (ApiGroupsIdPatchRequestBuilder()..update(updates))._build();

  _$ApiGroupsIdPatchRequest._({this.name}) : super._();
  @override
  ApiGroupsIdPatchRequest rebuild(
          void Function(ApiGroupsIdPatchRequestBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGroupsIdPatchRequestBuilder toBuilder() =>
      ApiGroupsIdPatchRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGroupsIdPatchRequest && name == other.name;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ApiGroupsIdPatchRequest')
          ..add('name', name))
        .toString();
  }
}

class ApiGroupsIdPatchRequestBuilder
    implements
        Builder<ApiGroupsIdPatchRequest, ApiGroupsIdPatchRequestBuilder> {
  _$ApiGroupsIdPatchRequest? _$v;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  ApiGroupsIdPatchRequestBuilder() {
    ApiGroupsIdPatchRequest._defaults(this);
  }

  ApiGroupsIdPatchRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _name = $v.name;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGroupsIdPatchRequest other) {
    _$v = other as _$ApiGroupsIdPatchRequest;
  }

  @override
  void update(void Function(ApiGroupsIdPatchRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGroupsIdPatchRequest build() => _build();

  _$ApiGroupsIdPatchRequest _build() {
    final _$result = _$v ??
        _$ApiGroupsIdPatchRequest._(
          name: name,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
