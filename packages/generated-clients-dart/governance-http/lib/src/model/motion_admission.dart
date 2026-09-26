//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'motion_admission.g.dart';

/// Append-only (DOMAIN DB-GOV-MOTION-ADMISSION). Only the chair decides (FLOW-MTG-003 C1).
///
/// Properties:
/// * [admissionId] - DB-GOV-MOTION-ADMISSION id (bigint, carried as a string to avoid JS precision loss)
/// * [motionId] - The late motion this admission decides
/// * [outcome] 
/// * [deferredToMeetingId] - The target meeting of a defer (PRD-MTG-003). Null for admit, and for a defer to the next meeting.
/// * [deferToNextMeeting] - True when the chair deferred the motion to \"the next meeting\" instead of naming one (DOMAIN DB-GOV-MOTION-ADMISSION). Always false for admit.
/// * [actorPersonId] 
/// * [decidedAt] 
@BuiltValue()
abstract class MotionAdmission implements Built<MotionAdmission, MotionAdmissionBuilder> {
  /// DB-GOV-MOTION-ADMISSION id (bigint, carried as a string to avoid JS precision loss)
  @BuiltValueField(wireName: r'admission_id')
  String get admissionId;

  /// The late motion this admission decides
  @BuiltValueField(wireName: r'motion_id')
  String get motionId;

  @BuiltValueField(wireName: r'outcome')
  MotionAdmissionOutcomeEnum get outcome;
  // enum outcomeEnum {  admit,  defer,  };

  /// The target meeting of a defer (PRD-MTG-003). Null for admit, and for a defer to the next meeting.
  @BuiltValueField(wireName: r'deferred_to_meeting_id')
  String? get deferredToMeetingId;

  /// True when the chair deferred the motion to \"the next meeting\" instead of naming one (DOMAIN DB-GOV-MOTION-ADMISSION). Always false for admit.
  @BuiltValueField(wireName: r'defer_to_next_meeting')
  bool get deferToNextMeeting;

  @BuiltValueField(wireName: r'actor_person_id')
  String get actorPersonId;

  @BuiltValueField(wireName: r'decided_at')
  DateTime get decidedAt;

  MotionAdmission._();

  factory MotionAdmission([void updates(MotionAdmissionBuilder b)]) = _$MotionAdmission;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MotionAdmissionBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MotionAdmission> get serializer => _$MotionAdmissionSerializer();
}

class _$MotionAdmissionSerializer implements PrimitiveSerializer<MotionAdmission> {
  @override
  final Iterable<Type> types = const [MotionAdmission, _$MotionAdmission];

  @override
  final String wireName = r'MotionAdmission';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MotionAdmission object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'admission_id';
    yield serializers.serialize(
      object.admissionId,
      specifiedType: const FullType(String),
    );
    yield r'motion_id';
    yield serializers.serialize(
      object.motionId,
      specifiedType: const FullType(String),
    );
    yield r'outcome';
    yield serializers.serialize(
      object.outcome,
      specifiedType: const FullType(MotionAdmissionOutcomeEnum),
    );
    if (object.deferredToMeetingId != null) {
      yield r'deferred_to_meeting_id';
      yield serializers.serialize(
        object.deferredToMeetingId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'defer_to_next_meeting';
    yield serializers.serialize(
      object.deferToNextMeeting,
      specifiedType: const FullType(bool),
    );
    yield r'actor_person_id';
    yield serializers.serialize(
      object.actorPersonId,
      specifiedType: const FullType(String),
    );
    yield r'decided_at';
    yield serializers.serialize(
      object.decidedAt,
      specifiedType: const FullType(DateTime),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    MotionAdmission object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MotionAdmissionBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'admission_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.admissionId = valueDes;
          break;
        case r'motion_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.motionId = valueDes;
          break;
        case r'outcome':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(MotionAdmissionOutcomeEnum),
          ) as MotionAdmissionOutcomeEnum;
          result.outcome = valueDes;
          break;
        case r'deferred_to_meeting_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.deferredToMeetingId = valueDes;
          break;
        case r'defer_to_next_meeting':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.deferToNextMeeting = valueDes;
          break;
        case r'actor_person_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.actorPersonId = valueDes;
          break;
        case r'decided_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.decidedAt = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  MotionAdmission deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MotionAdmissionBuilder();
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

class MotionAdmissionOutcomeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'admit')
  static const MotionAdmissionOutcomeEnum admit = _$motionAdmissionOutcomeEnum_admit;
  @BuiltValueEnumConst(wireName: r'defer')
  static const MotionAdmissionOutcomeEnum defer = _$motionAdmissionOutcomeEnum_defer;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MotionAdmissionOutcomeEnum unknownDefaultOpenApi = _$motionAdmissionOutcomeEnum_unknownDefaultOpenApi;

  static Serializer<MotionAdmissionOutcomeEnum> get serializer => _$motionAdmissionOutcomeEnumSerializer;

  const MotionAdmissionOutcomeEnum._(String name): super(name);

  static BuiltSet<MotionAdmissionOutcomeEnum> get values => _$motionAdmissionOutcomeEnumValues;
  static MotionAdmissionOutcomeEnum valueOf(String name) => _$motionAdmissionOutcomeEnumValueOf(name);
}

