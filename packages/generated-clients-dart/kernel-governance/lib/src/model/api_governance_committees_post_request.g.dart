// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_post_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const ApiGovernanceCommitteesPostRequestVisibilityEnum
    _$apiGovernanceCommitteesPostRequestVisibilityEnum_allMembers =
    const ApiGovernanceCommitteesPostRequestVisibilityEnum._('allMembers');
const ApiGovernanceCommitteesPostRequestVisibilityEnum
    _$apiGovernanceCommitteesPostRequestVisibilityEnum_committeeOnly =
    const ApiGovernanceCommitteesPostRequestVisibilityEnum._('committeeOnly');

ApiGovernanceCommitteesPostRequestVisibilityEnum
    _$apiGovernanceCommitteesPostRequestVisibilityEnumValueOf(String name) {
  switch (name) {
    case 'allMembers':
      return _$apiGovernanceCommitteesPostRequestVisibilityEnum_allMembers;
    case 'committeeOnly':
      return _$apiGovernanceCommitteesPostRequestVisibilityEnum_committeeOnly;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<ApiGovernanceCommitteesPostRequestVisibilityEnum>
    _$apiGovernanceCommitteesPostRequestVisibilityEnumValues = BuiltSet<
        ApiGovernanceCommitteesPostRequestVisibilityEnum>(const <ApiGovernanceCommitteesPostRequestVisibilityEnum>[
  _$apiGovernanceCommitteesPostRequestVisibilityEnum_allMembers,
  _$apiGovernanceCommitteesPostRequestVisibilityEnum_committeeOnly,
]);

Serializer<ApiGovernanceCommitteesPostRequestVisibilityEnum>
    _$apiGovernanceCommitteesPostRequestVisibilityEnumSerializer =
    _$ApiGovernanceCommitteesPostRequestVisibilityEnumSerializer();

class _$ApiGovernanceCommitteesPostRequestVisibilityEnumSerializer
    implements
        PrimitiveSerializer<ApiGovernanceCommitteesPostRequestVisibilityEnum> {
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
    ApiGovernanceCommitteesPostRequestVisibilityEnum
  ];
  @override
  final String wireName = 'ApiGovernanceCommitteesPostRequestVisibilityEnum';

  @override
  Object serialize(Serializers serializers,
          ApiGovernanceCommitteesPostRequestVisibilityEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  ApiGovernanceCommitteesPostRequestVisibilityEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      ApiGovernanceCommitteesPostRequestVisibilityEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$ApiGovernanceCommitteesPostRequest
    extends ApiGovernanceCommitteesPostRequest {
  @override
  final String name;
  @override
  final String? description;
  @override
  final String? parentId;
  @override
  final ApiGovernanceCommitteesPostRequestVisibilityEnum? visibility;

  factory _$ApiGovernanceCommitteesPostRequest(
          [void Function(ApiGovernanceCommitteesPostRequestBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesPostRequestBuilder()..update(updates))._build();

  _$ApiGovernanceCommitteesPostRequest._(
      {required this.name, this.description, this.parentId, this.visibility})
      : super._();
  @override
  ApiGovernanceCommitteesPostRequest rebuild(
          void Function(ApiGovernanceCommitteesPostRequestBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesPostRequestBuilder toBuilder() =>
      ApiGovernanceCommitteesPostRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesPostRequest &&
        name == other.name &&
        description == other.description &&
        parentId == other.parentId &&
        visibility == other.visibility;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, description.hashCode);
    _$hash = $jc(_$hash, parentId.hashCode);
    _$hash = $jc(_$hash, visibility.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ApiGovernanceCommitteesPostRequest')
          ..add('name', name)
          ..add('description', description)
          ..add('parentId', parentId)
          ..add('visibility', visibility))
        .toString();
  }
}

class ApiGovernanceCommitteesPostRequestBuilder
    implements
        Builder<ApiGovernanceCommitteesPostRequest,
            ApiGovernanceCommitteesPostRequestBuilder> {
  _$ApiGovernanceCommitteesPostRequest? _$v;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  String? _description;
  String? get description => _$this._description;
  set description(String? description) => _$this._description = description;

  String? _parentId;
  String? get parentId => _$this._parentId;
  set parentId(String? parentId) => _$this._parentId = parentId;

  ApiGovernanceCommitteesPostRequestVisibilityEnum? _visibility;
  ApiGovernanceCommitteesPostRequestVisibilityEnum? get visibility =>
      _$this._visibility;
  set visibility(
          ApiGovernanceCommitteesPostRequestVisibilityEnum? visibility) =>
      _$this._visibility = visibility;

  ApiGovernanceCommitteesPostRequestBuilder() {
    ApiGovernanceCommitteesPostRequest._defaults(this);
  }

  ApiGovernanceCommitteesPostRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _name = $v.name;
      _description = $v.description;
      _parentId = $v.parentId;
      _visibility = $v.visibility;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesPostRequest other) {
    _$v = other as _$ApiGovernanceCommitteesPostRequest;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesPostRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesPostRequest build() => _build();

  _$ApiGovernanceCommitteesPostRequest _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesPostRequest._(
          name: BuiltValueNullFieldError.checkNotNull(
              name, r'ApiGovernanceCommitteesPostRequest', 'name'),
          description: description,
          parentId: parentId,
          visibility: visibility,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
