// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_committees_id_child_term_patch_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiCommitteesIdChildTermPatchRequest
    extends ApiCommitteesIdChildTermPatchRequest {
  @override
  final String childTerm;

  factory _$ApiCommitteesIdChildTermPatchRequest(
          [void Function(ApiCommitteesIdChildTermPatchRequestBuilder)?
              updates]) =>
      (ApiCommitteesIdChildTermPatchRequestBuilder()..update(updates))._build();

  _$ApiCommitteesIdChildTermPatchRequest._({required this.childTerm})
      : super._();
  @override
  ApiCommitteesIdChildTermPatchRequest rebuild(
          void Function(ApiCommitteesIdChildTermPatchRequestBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiCommitteesIdChildTermPatchRequestBuilder toBuilder() =>
      ApiCommitteesIdChildTermPatchRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiCommitteesIdChildTermPatchRequest &&
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
    return (newBuiltValueToStringHelper(r'ApiCommitteesIdChildTermPatchRequest')
          ..add('childTerm', childTerm))
        .toString();
  }
}

class ApiCommitteesIdChildTermPatchRequestBuilder
    implements
        Builder<ApiCommitteesIdChildTermPatchRequest,
            ApiCommitteesIdChildTermPatchRequestBuilder> {
  _$ApiCommitteesIdChildTermPatchRequest? _$v;

  String? _childTerm;
  String? get childTerm => _$this._childTerm;
  set childTerm(String? childTerm) => _$this._childTerm = childTerm;

  ApiCommitteesIdChildTermPatchRequestBuilder() {
    ApiCommitteesIdChildTermPatchRequest._defaults(this);
  }

  ApiCommitteesIdChildTermPatchRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _childTerm = $v.childTerm;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiCommitteesIdChildTermPatchRequest other) {
    _$v = other as _$ApiCommitteesIdChildTermPatchRequest;
  }

  @override
  void update(
      void Function(ApiCommitteesIdChildTermPatchRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiCommitteesIdChildTermPatchRequest build() => _build();

  _$ApiCommitteesIdChildTermPatchRequest _build() {
    final _$result = _$v ??
        _$ApiCommitteesIdChildTermPatchRequest._(
          childTerm: BuiltValueNullFieldError.checkNotNull(
              childTerm, r'ApiCommitteesIdChildTermPatchRequest', 'childTerm'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
