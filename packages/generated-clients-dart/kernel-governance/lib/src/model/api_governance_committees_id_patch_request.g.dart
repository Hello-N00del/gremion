// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_patch_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const ApiGovernanceCommitteesIdPatchRequestVisibilityEnum
    _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_allMembers =
    const ApiGovernanceCommitteesIdPatchRequestVisibilityEnum._('allMembers');
const ApiGovernanceCommitteesIdPatchRequestVisibilityEnum
    _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_committeeOnly =
    const ApiGovernanceCommitteesIdPatchRequestVisibilityEnum._(
        'committeeOnly');

ApiGovernanceCommitteesIdPatchRequestVisibilityEnum
    _$apiGovernanceCommitteesIdPatchRequestVisibilityEnumValueOf(String name) {
  switch (name) {
    case 'allMembers':
      return _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_allMembers;
    case 'committeeOnly':
      return _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_committeeOnly;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<ApiGovernanceCommitteesIdPatchRequestVisibilityEnum>
    _$apiGovernanceCommitteesIdPatchRequestVisibilityEnumValues = BuiltSet<
        ApiGovernanceCommitteesIdPatchRequestVisibilityEnum>(const <ApiGovernanceCommitteesIdPatchRequestVisibilityEnum>[
  _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_allMembers,
  _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_committeeOnly,
]);

Serializer<ApiGovernanceCommitteesIdPatchRequestVisibilityEnum>
    _$apiGovernanceCommitteesIdPatchRequestVisibilityEnumSerializer =
    _$ApiGovernanceCommitteesIdPatchRequestVisibilityEnumSerializer();

class _$ApiGovernanceCommitteesIdPatchRequestVisibilityEnumSerializer
    implements
        PrimitiveSerializer<
            ApiGovernanceCommitteesIdPatchRequestVisibilityEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'allMembers': 'all_members',
    'committeeOnly': 'committee_only',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'all_members': 'allMembers',
    'committee_only': 'committeeOnly',
  };

  @override
  final Iterable<Type> types = const <Type>[
    ApiGovernanceCommitteesIdPatchRequestVisibilityEnum
  ];
  @override
  final String wireName = 'ApiGovernanceCommitteesIdPatchRequestVisibilityEnum';

  @override
  Object serialize(Serializers serializers,
          ApiGovernanceCommitteesIdPatchRequestVisibilityEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  ApiGovernanceCommitteesIdPatchRequestVisibilityEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      ApiGovernanceCommitteesIdPatchRequestVisibilityEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$ApiGovernanceCommitteesIdPatchRequest
    extends ApiGovernanceCommitteesIdPatchRequest {
  @override
  final String? name;
  @override
  final String? description;
  @override
  final ApiGovernanceCommitteesIdPatchRequestVisibilityEnum? visibility;

  factory _$ApiGovernanceCommitteesIdPatchRequest(
          [void Function(ApiGovernanceCommitteesIdPatchRequestBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdPatchRequestBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdPatchRequest._(
      {this.name, this.description, this.visibility})
      : super._();
  @override
  ApiGovernanceCommitteesIdPatchRequest rebuild(
          void Function(ApiGovernanceCommitteesIdPatchRequestBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdPatchRequestBuilder toBuilder() =>
      ApiGovernanceCommitteesIdPatchRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdPatchRequest &&
        name == other.name &&
        description == other.description &&
        visibility == other.visibility;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, description.hashCode);
    _$hash = $jc(_$hash, visibility.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdPatchRequest')
          ..add('name', name)
          ..add('description', description)
          ..add('visibility', visibility))
        .toString();
  }
}

class ApiGovernanceCommitteesIdPatchRequestBuilder
    implements
        Builder<ApiGovernanceCommitteesIdPatchRequest,
            ApiGovernanceCommitteesIdPatchRequestBuilder> {
  _$ApiGovernanceCommitteesIdPatchRequest? _$v;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  String? _description;
  String? get description => _$this._description;
  set description(String? description) => _$this._description = description;

  ApiGovernanceCommitteesIdPatchRequestVisibilityEnum? _visibility;
  ApiGovernanceCommitteesIdPatchRequestVisibilityEnum? get visibility =>
      _$this._visibility;
  set visibility(
          ApiGovernanceCommitteesIdPatchRequestVisibilityEnum? visibility) =>
      _$this._visibility = visibility;

  ApiGovernanceCommitteesIdPatchRequestBuilder() {
    ApiGovernanceCommitteesIdPatchRequest._defaults(this);
  }

  ApiGovernanceCommitteesIdPatchRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _name = $v.name;
      _description = $v.description;
      _visibility = $v.visibility;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdPatchRequest other) {
    _$v = other as _$ApiGovernanceCommitteesIdPatchRequest;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdPatchRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdPatchRequest build() => _build();

  _$ApiGovernanceCommitteesIdPatchRequest _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesIdPatchRequest._(
          name: name,
          description: description,
          visibility: visibility,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
