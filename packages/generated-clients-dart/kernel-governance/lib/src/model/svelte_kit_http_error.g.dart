// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'svelte_kit_http_error.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$SvelteKitHttpError extends SvelteKitHttpError {
  @override
  final String message;

  factory _$SvelteKitHttpError(
          [void Function(SvelteKitHttpErrorBuilder)? updates]) =>
      (SvelteKitHttpErrorBuilder()..update(updates))._build();

  _$SvelteKitHttpError._({required this.message}) : super._();
  @override
  SvelteKitHttpError rebuild(
          void Function(SvelteKitHttpErrorBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  SvelteKitHttpErrorBuilder toBuilder() =>
      SvelteKitHttpErrorBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is SvelteKitHttpError && message == other.message;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, message.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'SvelteKitHttpError')
          ..add('message', message))
        .toString();
  }
}

class SvelteKitHttpErrorBuilder
    implements Builder<SvelteKitHttpError, SvelteKitHttpErrorBuilder> {
  _$SvelteKitHttpError? _$v;

  String? _message;
  String? get message => _$this._message;
  set message(String? message) => _$this._message = message;

  SvelteKitHttpErrorBuilder() {
    SvelteKitHttpError._defaults(this);
  }

  SvelteKitHttpErrorBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _message = $v.message;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(SvelteKitHttpError other) {
    _$v = other as _$SvelteKitHttpError;
  }

  @override
  void update(void Function(SvelteKitHttpErrorBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  SvelteKitHttpError build() => _build();

  _$SvelteKitHttpError _build() {
    final _$result = _$v ??
        _$SvelteKitHttpError._(
          message: BuiltValueNullFieldError.checkNotNull(
              message, r'SvelteKitHttpError', 'message'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
