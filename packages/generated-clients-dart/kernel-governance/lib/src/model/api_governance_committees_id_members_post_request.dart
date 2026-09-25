//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/date.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_members_post_request.g.dart';

/// ApiGovernanceCommitteesIdMembersPostRequest
///
/// Properties:
/// * [userKeycloakId] 
/// * [membershipType] 
/// * [termStart] 
/// * [termEnd] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdMembersPostRequest implements Built<ApiGovernanceCommitteesIdMembersPostRequest, ApiGovernanceCommitteesIdMembersPostRequestBuilder> {
  @BuiltValueField(wireName: r'userKeycloakId')
  String get userKeycloakId;

  @BuiltValueField(wireName: r'membershipType')
  ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum? get membershipType;
  // enum membershipTypeEnum {  elected,  unelected,  employee,  };

  @BuiltValueField(wireName: r'termStart')
  Date? get termStart;

  @BuiltValueField(wireName: r'termEnd')
  Date? get termEnd;

  ApiGovernanceCommitteesIdMembersPostRequest._();

  factory ApiGovernanceCommitteesIdMembersPostRequest([void updates(ApiGovernanceCommitteesIdMembersPostRequestBuilder b)]) = _$ApiGovernanceCommitteesIdMembersPostRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdMembersPostRequestBuilder b) => b
      ..membershipType = const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum._('unelected');

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdMembersPostRequest> get serializer => _$ApiGovernanceCommitteesIdMembersPostRequestSerializer();
}

class _$ApiGovernanceCommitteesIdMembersPostRequestSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdMembersPostRequest> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdMembersPostRequest, _$ApiGovernanceCommitteesIdMembersPostRequest];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdMembersPostRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdMembersPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'userKeycloakId';
    yield serializers.serialize(
      object.userKeycloakId,
      specifiedType: const FullType(String),
    );
    if (object.membershipType != null) {
      yield r'membershipType';
      yield serializers.serialize(
        object.membershipType,
        specifiedType: const FullType(ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum),
      );
    }
    if (object.termStart != null) {
      yield r'termStart';
      yield serializers.serialize(
        object.termStart,
        specifiedType: const FullType.nullable(Date),
      );
    }
    if (object.termEnd != null) {
      yield r'termEnd';
      yield serializers.serialize(
        object.termEnd,
        specifiedType: const FullType.nullable(Date),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdMembersPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdMembersPostRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'userKeycloakId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.userKeycloakId = valueDes;
          break;
        case r'membershipType':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum),
          ) as ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum;
          result.membershipType = valueDes;
          break;
        case r'termStart':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.termStart = valueDes;
          break;
        case r'termEnd':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.termEnd = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGovernanceCommitteesIdMembersPostRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdMembersPostRequestBuilder();
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

class ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'elected')
  static const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum elected = _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_elected;
  @BuiltValueEnumConst(wireName: r'unelected')
  static const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum unelected = _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_unelected;
  @BuiltValueEnumConst(wireName: r'employee')
  static const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum employee = _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_employee;

  static Serializer<ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum> get serializer => _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumSerializer;

  const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum._(String name): super(name);

  static BuiltSet<ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum> get values => _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumValues;
  static ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum valueOf(String name) => _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumValueOf(name);
}

