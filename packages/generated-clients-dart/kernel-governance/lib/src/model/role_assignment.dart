//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'role_assignment.g.dart';

/// RoleAssignment
///
/// Properties:
/// * [id] 
/// * [roleId] 
/// * [userKeycloakId] 
/// * [startDate] 
/// * [endDate] 
/// * [status] 
/// * [assignedByKeycloakId] 
/// * [heliosElectionId] 
/// * [createdAt] 
@BuiltValue()
abstract class RoleAssignment implements Built<RoleAssignment, RoleAssignmentBuilder> {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'role_id')
  String get roleId;

  @BuiltValueField(wireName: r'user_keycloak_id')
  String get userKeycloakId;

  @BuiltValueField(wireName: r'start_date')
  DateTime? get startDate;

  @BuiltValueField(wireName: r'end_date')
  DateTime? get endDate;

  @BuiltValueField(wireName: r'status')
  RoleAssignmentStatusEnum get status;
  // enum statusEnum {  active,  grace,  expired,  vacated,  };

  @BuiltValueField(wireName: r'assigned_by_keycloak_id')
  String get assignedByKeycloakId;

  @BuiltValueField(wireName: r'helios_election_id')
  String? get heliosElectionId;

  @BuiltValueField(wireName: r'created_at')
  DateTime get createdAt;

  RoleAssignment._();

  factory RoleAssignment([void updates(RoleAssignmentBuilder b)]) = _$RoleAssignment;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(RoleAssignmentBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<RoleAssignment> get serializer => _$RoleAssignmentSerializer();
}

class _$RoleAssignmentSerializer implements PrimitiveSerializer<RoleAssignment> {
  @override
  final Iterable<Type> types = const [RoleAssignment, _$RoleAssignment];

  @override
  final String wireName = r'RoleAssignment';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    RoleAssignment object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'id';
    yield serializers.serialize(
      object.id,
      specifiedType: const FullType(String),
    );
    yield r'role_id';
    yield serializers.serialize(
      object.roleId,
      specifiedType: const FullType(String),
    );
    yield r'user_keycloak_id';
    yield serializers.serialize(
      object.userKeycloakId,
      specifiedType: const FullType(String),
    );
    if (object.startDate != null) {
      yield r'start_date';
      yield serializers.serialize(
        object.startDate,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    if (object.endDate != null) {
      yield r'end_date';
      yield serializers.serialize(
        object.endDate,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    yield r'status';
    yield serializers.serialize(
      object.status,
      specifiedType: const FullType(RoleAssignmentStatusEnum),
    );
    yield r'assigned_by_keycloak_id';
    yield serializers.serialize(
      object.assignedByKeycloakId,
      specifiedType: const FullType(String),
    );
    if (object.heliosElectionId != null) {
      yield r'helios_election_id';
      yield serializers.serialize(
        object.heliosElectionId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'created_at';
    yield serializers.serialize(
      object.createdAt,
      specifiedType: const FullType(DateTime),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    RoleAssignment object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required RoleAssignmentBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.id = valueDes;
          break;
        case r'role_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.roleId = valueDes;
          break;
        case r'user_keycloak_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.userKeycloakId = valueDes;
          break;
        case r'start_date':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.startDate = valueDes;
          break;
        case r'end_date':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.endDate = valueDes;
          break;
        case r'status':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(RoleAssignmentStatusEnum),
          ) as RoleAssignmentStatusEnum;
          result.status = valueDes;
          break;
        case r'assigned_by_keycloak_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.assignedByKeycloakId = valueDes;
          break;
        case r'helios_election_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.heliosElectionId = valueDes;
          break;
        case r'created_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.createdAt = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  RoleAssignment deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = RoleAssignmentBuilder();
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

class RoleAssignmentStatusEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'active')
  static const RoleAssignmentStatusEnum active = _$roleAssignmentStatusEnum_active;
  @BuiltValueEnumConst(wireName: r'grace')
  static const RoleAssignmentStatusEnum grace = _$roleAssignmentStatusEnum_grace;
  @BuiltValueEnumConst(wireName: r'expired')
  static const RoleAssignmentStatusEnum expired = _$roleAssignmentStatusEnum_expired;
  @BuiltValueEnumConst(wireName: r'vacated')
  static const RoleAssignmentStatusEnum vacated = _$roleAssignmentStatusEnum_vacated;

  static Serializer<RoleAssignmentStatusEnum> get serializer => _$roleAssignmentStatusEnumSerializer;

  const RoleAssignmentStatusEnum._(String name): super(name);

  static BuiltSet<RoleAssignmentStatusEnum> get values => _$roleAssignmentStatusEnumValues;
  static RoleAssignmentStatusEnum valueOf(String name) => _$roleAssignmentStatusEnumValueOf(name);
}

