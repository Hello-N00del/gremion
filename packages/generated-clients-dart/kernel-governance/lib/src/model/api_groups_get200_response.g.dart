// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_groups_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGroupsGet200Response extends ApiGroupsGet200Response {
  @override
  final JsonObject? success;
  @override
  final BuiltList<BuiltMap<String, JsonObject?>> data;

  factory _$ApiGroupsGet200Response(
          [void Function(ApiGroupsGet200ResponseBuilder)? updates]) =>
      (ApiGroupsGet200ResponseBuilder()..update(updates))._build();

  _$ApiGroupsGet200Response._({this.success, required this.data}) : super._();
  @override
  ApiGroupsGet200Response rebuild(
          void Function(ApiGroupsGet200ResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGroupsGet200ResponseBuilder toBuilder() =>
      ApiGroupsGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGroupsGet200Response &&
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
    return (newBuiltValueToStringHelper(r'ApiGroupsGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGroupsGet200ResponseBuilder
    implements
        Builder<ApiGroupsGet200Response, ApiGroupsGet200ResponseBuilder> {
  _$ApiGroupsGet200Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  ListBuilder<BuiltMap<String, JsonObject?>>? _data;
  ListBuilder<BuiltMap<String, JsonObject?>> get data =>
      _$this._data ??= ListBuilder<BuiltMap<String, JsonObject?>>();
  set data(ListBuilder<BuiltMap<String, JsonObject?>>? data) =>
      _$this._data = data;

  ApiGroupsGet200ResponseBuilder() {
    ApiGroupsGet200Response._defaults(this);
  }

  ApiGroupsGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGroupsGet200Response other) {
    _$v = other as _$ApiGroupsGet200Response;
  }

  @override
  void update(void Function(ApiGroupsGet200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGroupsGet200Response build() => _build();

  _$ApiGroupsGet200Response _build() {
    _$ApiGroupsGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGroupsGet200Response._(
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
            r'ApiGroupsGet200Response', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
