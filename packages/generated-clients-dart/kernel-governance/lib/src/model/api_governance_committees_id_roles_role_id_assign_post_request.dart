//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/date.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_roles_role_id_assign_post_request.g.dart';

/// ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest
///
/// Properties:
/// * [userKeycloakId] 
/// * [startDate] 
/// * [endDate] 
/// * [heliosElectionId] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest implements Built<ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest, ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder> {
  @BuiltValueField(wireName: r'userKeycloakId')
  String get userKeycloakId;

  @BuiltValueField(wireName: r'startDate')
  Date get startDate;

  @BuiltValueField(wireName: r'endDate')
  Date get endDate;

  @BuiltValueField(wireName: r'heliosElectionId')
  String? get heliosElectionId;

  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest._();

  factory ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest([void updates(ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder b)]) = _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest> get serializer => _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestSerializer();
}

class _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest, _$ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'userKeycloakId';
    yield serializers.serialize(
      object.userKeycloakId,
      specifiedType: const FullType(String),
    );
    yield r'startDate';
    yield serializers.serialize(
      object.startDate,
      specifiedType: const FullType(Date),
    );
    yield r'endDate';
    yield serializers.serialize(
      object.endDate,
      specifiedType: const FullType(Date),
    );
    if (object.heliosElectionId != null) {
      yield r'heliosElectionId';
      yield serializers.serialize(
        object.heliosElectionId,
        specifiedType: const FullType.nullable(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder result,
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
        case r'startDate':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(Date),
          ) as Date;
          result.startDate = valueDes;
          break;
        case r'endDate':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(Date),
          ) as Date;
          result.endDate = valueDes;
          break;
        case r'heliosElectionId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.heliosElectionId = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequestBuilder();
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

