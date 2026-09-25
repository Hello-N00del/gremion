// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_groups_id_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGroupsIdGet200Response extends ApiGroupsIdGet200Response {
  @override
  final bool success;
  @override
  final BuiltMap<String, JsonObject?> data;

  factory _$ApiGroupsIdGet200Response(
          [void Function(ApiGroupsIdGet200ResponseBuilder)? updates]) =>
      (ApiGroupsIdGet200ResponseBuilder()..update(updates))._build();

  _$ApiGroupsIdGet200Response._({required this.success, required this.data})
      : super._();
  @override
  ApiGroupsIdGet200Response rebuild(
          void Function(ApiGroupsIdGet200ResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGroupsIdGet200ResponseBuilder toBuilder() =>
      ApiGroupsIdGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGroupsIdGet200Response &&
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
    return (newBuiltValueToStringHelper(r'ApiGroupsIdGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGroupsIdGet200ResponseBuilder
    implements
        Builder<ApiGroupsIdGet200Response, ApiGroupsIdGet200ResponseBuilder> {
  _$ApiGroupsIdGet200Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  MapBuilder<String, JsonObject?>? _data;
  MapBuilder<String, JsonObject?> get data =>
      _$this._data ??= MapBuilder<String, JsonObject?>();
  set data(MapBuilder<String, JsonObject?>? data) => _$this._data = data;

  ApiGroupsIdGet200ResponseBuilder() {
    ApiGroupsIdGet200Response._defaults(this);
  }

  ApiGroupsIdGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGroupsIdGet200Response other) {
    _$v = other as _$ApiGroupsIdGet200Response;
  }

  @override
  void update(void Function(ApiGroupsIdGet200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGroupsIdGet200Response build() => _build();

  _$ApiGroupsIdGet200Response _build() {
    _$ApiGroupsIdGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiGroupsIdGet200Response._(
            success: BuiltValueNullFieldError.checkNotNull(
                success, r'ApiGroupsIdGet200Response', 'success'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGroupsIdGet200Response', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
