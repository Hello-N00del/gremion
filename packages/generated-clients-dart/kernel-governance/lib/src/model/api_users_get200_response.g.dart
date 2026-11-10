// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_users_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiUsersGet200Response extends ApiUsersGet200Response {
  @override
  final bool success;
  @override
  final BuiltList<ApiUsersGet200ResponseDataInner> data;

  factory _$ApiUsersGet200Response(
          [void Function(ApiUsersGet200ResponseBuilder)? updates]) =>
      (ApiUsersGet200ResponseBuilder()..update(updates))._build();

  _$ApiUsersGet200Response._({required this.success, required this.data})
      : super._();
  @override
  ApiUsersGet200Response rebuild(
          void Function(ApiUsersGet200ResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiUsersGet200ResponseBuilder toBuilder() =>
      ApiUsersGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiUsersGet200Response &&
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
    return (newBuiltValueToStringHelper(r'ApiUsersGet200Response')
          ..add('success', success)
          ..add('data', data))
        .toString();
  }
}

class ApiUsersGet200ResponseBuilder
    implements Builder<ApiUsersGet200Response, ApiUsersGet200ResponseBuilder> {
  _$ApiUsersGet200Response? _$v;

  bool? _success;
  bool? get success => _$this._success;
  set success(bool? success) => _$this._success = success;

  ListBuilder<ApiUsersGet200ResponseDataInner>? _data;
  ListBuilder<ApiUsersGet200ResponseDataInner> get data =>
      _$this._data ??= ListBuilder<ApiUsersGet200ResponseDataInner>();
  set data(ListBuilder<ApiUsersGet200ResponseDataInner>? data) =>
      _$this._data = data;

  ApiUsersGet200ResponseBuilder() {
    ApiUsersGet200Response._defaults(this);
  }

  ApiUsersGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _success = $v.success;
      _data = $v.data.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiUsersGet200Response other) {
    _$v = other as _$ApiUsersGet200Response;
  }

  @override
  void update(void Function(ApiUsersGet200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiUsersGet200Response build() => _build();

  _$ApiUsersGet200Response _build() {
    _$ApiUsersGet200Response _$result;
    try {
      _$result = _$v ??
          _$ApiUsersGet200Response._(
            success: BuiltValueNullFieldError.checkNotNull(
                success, r'ApiUsersGet200Response', 'success'),
            data: data.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'data';
        data.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiUsersGet200Response', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
