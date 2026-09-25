// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_health_get200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiHealthGet200Response extends ApiHealthGet200Response {
  @override
  final String status;

  factory _$ApiHealthGet200Response(
          [void Function(ApiHealthGet200ResponseBuilder)? updates]) =>
      (ApiHealthGet200ResponseBuilder()..update(updates))._build();

  _$ApiHealthGet200Response._({required this.status}) : super._();
  @override
  ApiHealthGet200Response rebuild(
          void Function(ApiHealthGet200ResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiHealthGet200ResponseBuilder toBuilder() =>
      ApiHealthGet200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiHealthGet200Response && status == other.status;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, status.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ApiHealthGet200Response')
          ..add('status', status))
        .toString();
  }
}

class ApiHealthGet200ResponseBuilder
    implements
        Builder<ApiHealthGet200Response, ApiHealthGet200ResponseBuilder> {
  _$ApiHealthGet200Response? _$v;

  String? _status;
  String? get status => _$this._status;
  set status(String? status) => _$this._status = status;

  ApiHealthGet200ResponseBuilder() {
    ApiHealthGet200Response._defaults(this);
  }

  ApiHealthGet200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _status = $v.status;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiHealthGet200Response other) {
    _$v = other as _$ApiHealthGet200Response;
  }

  @override
  void update(void Function(ApiHealthGet200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiHealthGet200Response build() => _build();

  _$ApiHealthGet200Response _build() {
    final _$result = _$v ??
        _$ApiHealthGet200Response._(
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'ApiHealthGet200Response', 'status'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
