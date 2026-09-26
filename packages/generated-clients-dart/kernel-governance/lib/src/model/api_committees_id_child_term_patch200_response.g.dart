// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_committees_id_child_term_patch200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiCommitteesIdChildTermPatch200Response
    extends ApiCommitteesIdChildTermPatch200Response {
  @override
  final String? childTerm;

  factory _$ApiCommitteesIdChildTermPatch200Response(
          [void Function(ApiCommitteesIdChildTermPatch200ResponseBuilder)?
              updates]) =>
      (ApiCommitteesIdChildTermPatch200ResponseBuilder()..update(updates))
          ._build();

  _$ApiCommitteesIdChildTermPatch200Response._({this.childTerm}) : super._();
  @override
  ApiCommitteesIdChildTermPatch200Response rebuild(
          void Function(ApiCommitteesIdChildTermPatch200ResponseBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiCommitteesIdChildTermPatch200ResponseBuilder toBuilder() =>
      ApiCommitteesIdChildTermPatch200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiCommitteesIdChildTermPatch200Response &&
        childTerm == other.childTerm;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, childTerm.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiCommitteesIdChildTermPatch200Response')
          ..add('childTerm', childTerm))
        .toString();
  }
}

class ApiCommitteesIdChildTermPatch200ResponseBuilder
    implements
        Builder<ApiCommitteesIdChildTermPatch200Response,
            ApiCommitteesIdChildTermPatch200ResponseBuilder> {
  _$ApiCommitteesIdChildTermPatch200Response? _$v;

  String? _childTerm;
  String? get childTerm => _$this._childTerm;
  set childTerm(String? childTerm) => _$this._childTerm = childTerm;

  ApiCommitteesIdChildTermPatch200ResponseBuilder() {
    ApiCommitteesIdChildTermPatch200Response._defaults(this);
  }

  ApiCommitteesIdChildTermPatch200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _childTerm = $v.childTerm;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiCommitteesIdChildTermPatch200Response other) {
    _$v = other as _$ApiCommitteesIdChildTermPatch200Response;
  }

  @override
  void update(
      void Function(ApiCommitteesIdChildTermPatch200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiCommitteesIdChildTermPatch200Response build() => _build();

  _$ApiCommitteesIdChildTermPatch200Response _build() {
    final _$result = _$v ??
        _$ApiCommitteesIdChildTermPatch200Response._(
          childTerm: childTerm,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
