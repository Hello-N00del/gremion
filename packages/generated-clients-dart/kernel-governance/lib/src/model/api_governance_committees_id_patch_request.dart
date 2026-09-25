//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_patch_request.g.dart';

/// ApiGovernanceCommitteesIdPatchRequest
///
/// Properties:
/// * [name] 
/// * [description] 
/// * [visibility] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdPatchRequest implements Built<ApiGovernanceCommitteesIdPatchRequest, ApiGovernanceCommitteesIdPatchRequestBuilder> {
  @BuiltValueField(wireName: r'name')
  String? get name;

  @BuiltValueField(wireName: r'description')
  String? get description;

  @BuiltValueField(wireName: r'visibility')
  ApiGovernanceCommitteesIdPatchRequestVisibilityEnum? get visibility;
  // enum visibilityEnum {  all_members,  committee_only,  };

  ApiGovernanceCommitteesIdPatchRequest._();

  factory ApiGovernanceCommitteesIdPatchRequest([void updates(ApiGovernanceCommitteesIdPatchRequestBuilder b)]) = _$ApiGovernanceCommitteesIdPatchRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdPatchRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdPatchRequest> get serializer => _$ApiGovernanceCommitteesIdPatchRequestSerializer();
}

class _$ApiGovernanceCommitteesIdPatchRequestSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdPatchRequest> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdPatchRequest, _$ApiGovernanceCommitteesIdPatchRequest];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdPatchRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdPatchRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    if (object.name != null) {
      yield r'name';
      yield serializers.serialize(
        object.name,
        specifiedType: const FullType(String),
      );
    }
    if (object.description != null) {
      yield r'description';
      yield serializers.serialize(
        object.description,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.visibility != null) {
      yield r'visibility';
      yield serializers.serialize(
        object.visibility,
        specifiedType: const FullType(ApiGovernanceCommitteesIdPatchRequestVisibilityEnum),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdPatchRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdPatchRequestBuilder result,
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
        case r'visibility':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ApiGovernanceCommitteesIdPatchRequestVisibilityEnum),
          ) as ApiGovernanceCommitteesIdPatchRequestVisibilityEnum;
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
  ApiGovernanceCommitteesIdPatchRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdPatchRequestBuilder();
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

class ApiGovernanceCommitteesIdPatchRequestVisibilityEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'all_members')
  static const ApiGovernanceCommitteesIdPatchRequestVisibilityEnum allMembers = _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_allMembers;
  @BuiltValueEnumConst(wireName: r'committee_only')
  static const ApiGovernanceCommitteesIdPatchRequestVisibilityEnum committeeOnly = _$apiGovernanceCommitteesIdPatchRequestVisibilityEnum_committeeOnly;

  static Serializer<ApiGovernanceCommitteesIdPatchRequestVisibilityEnum> get serializer => _$apiGovernanceCommitteesIdPatchRequestVisibilityEnumSerializer;

  const ApiGovernanceCommitteesIdPatchRequestVisibilityEnum._(String name): super(name);

  static BuiltSet<ApiGovernanceCommitteesIdPatchRequestVisibilityEnum> get values => _$apiGovernanceCommitteesIdPatchRequestVisibilityEnumValues;
  static ApiGovernanceCommitteesIdPatchRequestVisibilityEnum valueOf(String name) => _$apiGovernanceCommitteesIdPatchRequestVisibilityEnumValueOf(name);
}

