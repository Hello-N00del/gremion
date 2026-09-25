// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_groups_post201_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGroupsPost201Response extends ApiGroupsPost201Response {
  @override
  final JsonObject? success;
  @override
  final ApiGroupsPost201ResponseData data;

  factory _$ApiGroupsPost201Response(
          [void Function(ApiGroupsPost201ResponseBuilder)? updates]) =>
      (ApiGroupsPost201ResponseBuilder()..update(updates))._build();

  _$ApiGroupsPost201Response._({this.success, required this.data}) : super._();
  @override
  ApiGroupsPost201Response rebuild(
          void Function(ApiGroupsPost201ResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGroupsPost201ResponseBuilder toBuilder() =>
      ApiGroupsPost201ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGroupsPost201Response &&
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
    return (newBuiltValueToStringHelper(r'ApiGroupsPost201Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiGroupsPost201ResponseBuilder
    implements
        Builder<ApiGroupsPost201Response, ApiGroupsPost201ResponseBuilder> {
  _$ApiGroupsPost201Response? _$v;

  JsonObject? _success;
  JsonObject? get success => _$this._success;
  set success(JsonObject? success) => _$this._success = success;

  ApiGroupsPost201ResponseDataBuilder? _data;
  ApiGroupsPost201ResponseDataBuilder get data =>
      _$this._data ??= ApiGroupsPost201ResponseDataBuilder();
  set data(ApiGroupsPost201ResponseDataBuilder? data) => _$this._data = data;

  ApiGroupsPost201ResponseBuilder() {
    ApiGroupsPost201Response._defaults(this);
  }

  ApiGroupsPost201ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGroupsPost201Response other) {
    _$v = other as _$ApiGroupsPost201Response;
  }

  @override
  void update(void Function(ApiGroupsPost201ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGroupsPost201Response build() => _build();

  _$ApiGroupsPost201Response _build() {
    _$ApiGroupsPost201Response _$result;
    try {
      _$result = _$v ??
          _$ApiGroupsPost201Response._(
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
            r'ApiGroupsPost201Response', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
