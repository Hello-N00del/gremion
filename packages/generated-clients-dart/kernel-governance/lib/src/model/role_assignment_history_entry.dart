//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'role_assignment_history_entry.g.dart';

/// Archived role assignment; user_keycloak_id is '[redacted]' for non-members or '[gelöschtes Mitglied]' after GDPR erasure — see listHistory
///
/// Properties:
/// * [id] 
/// * [roleId] 
/// * [userKeycloakId] - Keycloak user id, '[redacted]' for non-members, or '[gelöschtes Mitglied]' after GDPR hard erasure
/// * [startDate] 
/// * [endDate] 
/// * [endedReason] 
/// * [createdAt] 
@BuiltValue()
abstract class RoleAssignmentHistoryEntry implements Built<RoleAssignmentHistoryEntry, RoleAssignmentHistoryEntryBuilder> {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'role_id')
  String get roleId;

  /// Keycloak user id, '[redacted]' for non-members, or '[gelöschtes Mitglied]' after GDPR hard erasure
  @BuiltValueField(wireName: r'user_keycloak_id')
  String? get userKeycloakId;

  @BuiltValueField(wireName: r'start_date')
  DateTime get startDate;

  @BuiltValueField(wireName: r'end_date')
  DateTime get endDate;

  @BuiltValueField(wireName: r'ended_reason')
  RoleAssignmentHistoryEntryEndedReasonEnum get endedReason;
  // enum endedReasonEnum {  expired,  resigned,  removed,  };

  @BuiltValueField(wireName: r'created_at')
  DateTime get createdAt;

  RoleAssignmentHistoryEntry._();

  factory RoleAssignmentHistoryEntry([void updates(RoleAssignmentHistoryEntryBuilder b)]) = _$RoleAssignmentHistoryEntry;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(RoleAssignmentHistoryEntryBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<RoleAssignmentHistoryEntry> get serializer => _$RoleAssignmentHistoryEntrySerializer();
}

class _$RoleAssignmentHistoryEntrySerializer implements PrimitiveSerializer<RoleAssignmentHistoryEntry> {
  @override
  final Iterable<Type> types = const [RoleAssignmentHistoryEntry, _$RoleAssignmentHistoryEntry];

  @override
  final String wireName = r'RoleAssignmentHistoryEntry';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    RoleAssignmentHistoryEntry object, {
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
    if (object.userKeycloakId != null) {
      yield r'user_keycloak_id';
      yield serializers.serialize(
        object.userKeycloakId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'start_date';
    yield serializers.serialize(
      object.startDate,
      specifiedType: const FullType(DateTime),
    );
    yield r'end_date';
    yield serializers.serialize(
      object.endDate,
      specifiedType: const FullType(DateTime),
    );
    yield r'ended_reason';
    yield serializers.serialize(
      object.endedReason,
      specifiedType: const FullType(RoleAssignmentHistoryEntryEndedReasonEnum),
    );
    yield r'created_at';
    yield serializers.serialize(
      object.createdAt,
      specifiedType: const FullType(DateTime),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    RoleAssignmentHistoryEntry object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required RoleAssignmentHistoryEntryBuilder result,
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
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.userKeycloakId = valueDes;
          break;
        case r'start_date':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.startDate = valueDes;
          break;
        case r'end_date':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.endDate = valueDes;
          break;
        case r'ended_reason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(RoleAssignmentHistoryEntryEndedReasonEnum),
          ) as RoleAssignmentHistoryEntryEndedReasonEnum;
          result.endedReason = valueDes;
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
  RoleAssignmentHistoryEntry deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = RoleAssignmentHistoryEntryBuilder();
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

class RoleAssignmentHistoryEntryEndedReasonEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'expired')
  static const RoleAssignmentHistoryEntryEndedReasonEnum expired = _$roleAssignmentHistoryEntryEndedReasonEnum_expired;
  @BuiltValueEnumConst(wireName: r'resigned')
  static const RoleAssignmentHistoryEntryEndedReasonEnum resigned = _$roleAssignmentHistoryEntryEndedReasonEnum_resigned;
  @BuiltValueEnumConst(wireName: r'removed')
  static const RoleAssignmentHistoryEntryEndedReasonEnum removed = _$roleAssignmentHistoryEntryEndedReasonEnum_removed;

  static Serializer<RoleAssignmentHistoryEntryEndedReasonEnum> get serializer => _$roleAssignmentHistoryEntryEndedReasonEnumSerializer;

  const RoleAssignmentHistoryEntryEndedReasonEnum._(String name): super(name);

  static BuiltSet<RoleAssignmentHistoryEntryEndedReasonEnum> get values => _$roleAssignmentHistoryEntryEndedReasonEnumValues;
  static RoleAssignmentHistoryEntryEndedReasonEnum valueOf(String name) => _$roleAssignmentHistoryEntryEndedReasonEnumValueOf(name);
}

