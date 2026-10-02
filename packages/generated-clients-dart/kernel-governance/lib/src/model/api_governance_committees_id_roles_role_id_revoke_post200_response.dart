//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_roles_role_id_revoke_post200_response.g.dart';

/// ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response
///
/// Properties:
/// * [success] 
/// * [groupsReconciled] - false when the recall was recorded but the revoked holder's auto-managed Keycloak groups could not be reconciled (the admin must check them)
@BuiltValue()
abstract class ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response implements Built<ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response, ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  /// false when the recall was recorded but the revoked holder's auto-managed Keycloak groups could not be reconciled (the admin must check them)
  @BuiltValueField(wireName: r'groupsReconciled')
  bool get groupsReconciled;

  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response._();

  factory ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response([void updates(ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response> get serializer => _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response, _$ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'success';
    yield serializers.serialize(
      object.success,
      specifiedType: const FullType(bool),
    );
    yield r'groupsReconciled';
    yield serializers.serialize(
      object.groupsReconciled,
      specifiedType: const FullType(bool),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'success':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.success = valueDes;
          break;
        case r'groupsReconciled':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.groupsReconciled = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdRolesRoleIdRevokePost200ResponseBuilder();
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

