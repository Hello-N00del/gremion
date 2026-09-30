//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/role_assignment.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_roles_role_id_assign_post201_response.g.dart';

/// ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response
///
/// Properties:
/// * [success] 
/// * [data] 
/// * [groupsReconciled] - false when the assignment was stored but the auto-managed Keycloak groups of the incoming or outgoing holder could not be reconciled (the admin must check them)
@BuiltValue()
abstract class ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response implements Built<ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response, ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  @BuiltValueField(wireName: r'data')
  RoleAssignment get data;

  /// false when the assignment was stored but the auto-managed Keycloak groups of the incoming or outgoing holder could not be reconciled (the admin must check them)
  @BuiltValueField(wireName: r'groupsReconciled')
  bool? get groupsReconciled;

  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response._();

  factory ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response([void updates(ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response> get serializer => _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response, _$ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'success';
    yield serializers.serialize(
      object.success,
      specifiedType: const FullType(bool),
    );
    yield r'data';
    yield serializers.serialize(
      object.data,
      specifiedType: const FullType(RoleAssignment),
    );
    if (object.groupsReconciled != null) {
      yield r'groupsReconciled';
      yield serializers.serialize(
        object.groupsReconciled,
        specifiedType: const FullType(bool),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder result,
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
        case r'data':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(RoleAssignment),
          ) as RoleAssignment;
          result.data.replace(valueDes);
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
  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdRolesRoleIdAssignPost201ResponseBuilder();
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

