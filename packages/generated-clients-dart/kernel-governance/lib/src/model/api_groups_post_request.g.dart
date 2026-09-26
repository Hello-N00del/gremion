// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_groups_post_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGroupsPostRequest extends ApiGroupsPostRequest {
  @override
  final String name;

  factory _$ApiGroupsPostRequest(
          [void Function(ApiGroupsPostRequestBuilder)? updates]) =>
      (ApiGroupsPostRequestBuilder()..update(updates))._build();

  _$ApiGroupsPostRequest._({required this.name}) : super._();
  @override
  ApiGroupsPostRequest rebuild(
          void Function(ApiGroupsPostRequestBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGroupsPostRequestBuilder toBuilder() =>
      ApiGroupsPostRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGroupsPostRequest && name == other.name;
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
    return (newBuiltValueToStringHelper(r'ApiGroupsPostRequest')
          ..add('name', name))
        .toString();
  }
}

class ApiGroupsPostRequestBuilder
    implements Builder<ApiGroupsPostRequest, ApiGroupsPostRequestBuilder> {
  _$ApiGroupsPostRequest? _$v;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  ApiGroupsPostRequestBuilder() {
    ApiGroupsPostRequest._defaults(this);
  }

  ApiGroupsPostRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _name = $v.name;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGroupsPostRequest other) {
    _$v = other as _$ApiGroupsPostRequest;
  }

  @override
  void update(void Function(ApiGroupsPostRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGroupsPostRequest build() => _build();

  _$ApiGroupsPostRequest _build() {
    final _$result = _$v ??
        _$ApiGroupsPostRequest._(
          name: BuiltValueNullFieldError.checkNotNull(
              name, r'ApiGroupsPostRequest', 'name'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
