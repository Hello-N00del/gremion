//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_post_request.g.dart';

/// ApiGovernanceCommitteesPostRequest
///
/// Properties:
/// * [name] 
/// * [description] 
/// * [parentId] - Must reference an existing org-unit; its kind is checked by validateCreatePlacement against the tenant org-unit-kind catalog (P2.2 #202). Committees cannot be roots in the StuRa catalog, so null is rejected by the placement check.
/// * [visibility] 
@BuiltValue()
abstract class ApiGovernanceCommitteesPostRequest implements Built<ApiGovernanceCommitteesPostRequest, ApiGovernanceCommitteesPostRequestBuilder> {
  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'description')
  String? get description;

  /// Must reference an existing org-unit; its kind is checked by validateCreatePlacement against the tenant org-unit-kind catalog (P2.2 #202). Committees cannot be roots in the StuRa catalog, so null is rejected by the placement check.
  @BuiltValueField(wireName: r'parentId')
  String? get parentId;

  @BuiltValueField(wireName: r'visibility')
  ApiGovernanceCommitteesPostRequestVisibilityEnum? get visibility;
  // enum visibilityEnum {  all_members,  committee_only,  };

  ApiGovernanceCommitteesPostRequest._();

  factory ApiGovernanceCommitteesPostRequest([void updates(ApiGovernanceCommitteesPostRequestBuilder b)]) = _$ApiGovernanceCommitteesPostRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesPostRequestBuilder b) => b
      ..visibility = const ApiGovernanceCommitteesPostRequestVisibilityEnum._('all_members');

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesPostRequest> get serializer => _$ApiGovernanceCommitteesPostRequestSerializer();
}

class _$ApiGovernanceCommitteesPostRequestSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesPostRequest> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesPostRequest, _$ApiGovernanceCommitteesPostRequest];

  @override
  final String wireName = r'ApiGovernanceCommitteesPostRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'name';
    yield serializers.serialize(
      object.name,
      specifiedType: const FullType(String),
    );
    if (object.description != null) {
      yield r'description';
      yield serializers.serialize(
        object.description,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.parentId != null) {
      yield r'parentId';
      yield serializers.serialize(
        object.parentId,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.visibility != null) {
      yield r'visibility';
      yield serializers.serialize(
        object.visibility,
        specifiedType: const FullType(ApiGovernanceCommitteesPostRequestVisibilityEnum),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesPostRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        case r'description':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.description = valueDes;
          break;
        case r'parentId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.parentId = valueDes;
          break;
        case r'visibility':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ApiGovernanceCommitteesPostRequestVisibilityEnum),
          ) as ApiGovernanceCommitteesPostRequestVisibilityEnum;
          result.visibility = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGovernanceCommitteesPostRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesPostRequestBuilder();
    final serializedList = (serialized as Iterable<Object?>).toList();
    final unhandled = <Object?>[];
    _deserializeProperties(
      serializers,
      serialized,
      specifiedType: specifiedType,
      serializedList: serializedList,
      unhandled: unhandled,
      result: result,
    );
    return result.build();
  }
}

class ApiGovernanceCommitteesPostRequestVisibilityEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'all_members')
  static const ApiGovernanceCommitteesPostRequestVisibilityEnum allMembers = _$apiGovernanceCommitteesPostRequestVisibilityEnum_allMembers;
  @BuiltValueEnumConst(wireName: r'committee_only')
  static const ApiGovernanceCommitteesPostRequestVisibilityEnum committeeOnly = _$apiGovernanceCommitteesPostRequestVisibilityEnum_committeeOnly;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const ApiGovernanceCommitteesPostRequestVisibilityEnum unknownDefaultOpenApi = _$apiGovernanceCommitteesPostRequestVisibilityEnum_unknownDefaultOpenApi;

  static Serializer<ApiGovernanceCommitteesPostRequestVisibilityEnum> get serializer => _$apiGovernanceCommitteesPostRequestVisibilityEnumSerializer;

  const ApiGovernanceCommitteesPostRequestVisibilityEnum._(String name): super(name);

  static BuiltSet<ApiGovernanceCommitteesPostRequestVisibilityEnum> get values => _$apiGovernanceCommitteesPostRequestVisibilityEnumValues;
  static ApiGovernanceCommitteesPostRequestVisibilityEnum valueOf(String name) => _$apiGovernanceCommitteesPostRequestVisibilityEnumValueOf(name);
}

