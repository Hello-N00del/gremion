//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'motion_admission_create.g.dart';

/// A defer names exactly one target: deferred_to_meeting_id, or defer_to_next_meeting: true. An admit names neither (DOMAIN DB-GOV-MOTION-ADMISSION).
///
/// Properties:
/// * [outcome] 
/// * [deferredToMeetingId] - The target meeting of a defer. Exactly one of this and defer_to_next_meeting is sent for a defer; neither for admit.
/// * [deferToNextMeeting] - Send true to defer the motion to \"the next meeting\" instead of naming one. Exactly one of this and deferred_to_meeting_id is sent for a defer; neither for admit.
@BuiltValue()
abstract class MotionAdmissionCreate implements Built<MotionAdmissionCreate, MotionAdmissionCreateBuilder> {
  @BuiltValueField(wireName: r'outcome')
  MotionAdmissionCreateOutcomeEnum get outcome;
  // enum outcomeEnum {  admit,  defer,  };

  /// The target meeting of a defer. Exactly one of this and defer_to_next_meeting is sent for a defer; neither for admit.
  @BuiltValueField(wireName: r'deferred_to_meeting_id')
  String? get deferredToMeetingId;

  /// Send true to defer the motion to \"the next meeting\" instead of naming one. Exactly one of this and deferred_to_meeting_id is sent for a defer; neither for admit.
  @BuiltValueField(wireName: r'defer_to_next_meeting')
  bool? get deferToNextMeeting;

  MotionAdmissionCreate._();

  factory MotionAdmissionCreate([void updates(MotionAdmissionCreateBuilder b)]) = _$MotionAdmissionCreate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MotionAdmissionCreateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MotionAdmissionCreate> get serializer => _$MotionAdmissionCreateSerializer();
}

class _$MotionAdmissionCreateSerializer implements PrimitiveSerializer<MotionAdmissionCreate> {
  @override
  final Iterable<Type> types = const [MotionAdmissionCreate, _$MotionAdmissionCreate];

  @override
  final String wireName = r'MotionAdmissionCreate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MotionAdmissionCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'outcome';
    yield serializers.serialize(
      object.outcome,
      specifiedType: const FullType(MotionAdmissionCreateOutcomeEnum),
    );
    if (object.deferredToMeetingId != null) {
      yield r'deferred_to_meeting_id';
      yield serializers.serialize(
        object.deferredToMeetingId,
        specifiedType: const FullType(String),
      );
    }
    if (object.deferToNextMeeting != null) {
      yield r'defer_to_next_meeting';
      yield serializers.serialize(
        object.deferToNextMeeting,
        specifiedType: const FullType(bool),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    MotionAdmissionCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MotionAdmissionCreateBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'outcome':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(MotionAdmissionCreateOutcomeEnum),
          ) as MotionAdmissionCreateOutcomeEnum;
          result.outcome = valueDes;
          break;
        case r'deferred_to_meeting_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.deferredToMeetingId = valueDes;
          break;
        case r'defer_to_next_meeting':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.deferToNextMeeting = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  MotionAdmissionCreate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MotionAdmissionCreateBuilder();
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

class MotionAdmissionCreateOutcomeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'admit')
  static const MotionAdmissionCreateOutcomeEnum admit = _$motionAdmissionCreateOutcomeEnum_admit;
  @BuiltValueEnumConst(wireName: r'defer')
  static const MotionAdmissionCreateOutcomeEnum defer = _$motionAdmissionCreateOutcomeEnum_defer;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MotionAdmissionCreateOutcomeEnum unknownDefaultOpenApi = _$motionAdmissionCreateOutcomeEnum_unknownDefaultOpenApi;

  static Serializer<MotionAdmissionCreateOutcomeEnum> get serializer => _$motionAdmissionCreateOutcomeEnumSerializer;

  const MotionAdmissionCreateOutcomeEnum._(String name): super(name);

  static BuiltSet<MotionAdmissionCreateOutcomeEnum> get values => _$motionAdmissionCreateOutcomeEnumValues;
  static MotionAdmissionCreateOutcomeEnum valueOf(String name) => _$motionAdmissionCreateOutcomeEnumValueOf(name);
}

