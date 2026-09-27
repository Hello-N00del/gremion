//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'meeting_update.g.dart';

/// Retitle, relocate or reschedule. body_id is immutable and not accepted here (DOMAIN DB-GOV-MEETING invariant). A change of start or end emits de.gremion.gov.meeting.rescheduled.v1.
///
/// Properties:
/// * [title] - DB-GOV-MEETING.title (optional on update).
/// * [scheduledStart] 
/// * [scheduledEnd] - Send null to clear the end (SCHEMA gov.meeting.scheduled_end nullable).
/// * [location] - Send null to clear the location (SCHEMA gov.meeting.location nullable).
@BuiltValue()
abstract class MeetingUpdate implements Built<MeetingUpdate, MeetingUpdateBuilder> {
  /// DB-GOV-MEETING.title (optional on update).
  @BuiltValueField(wireName: r'title')
  String? get title;

  @BuiltValueField(wireName: r'scheduled_start')
  DateTime? get scheduledStart;

  /// Send null to clear the end (SCHEMA gov.meeting.scheduled_end nullable).
  @BuiltValueField(wireName: r'scheduled_end')
  DateTime? get scheduledEnd;

  /// Send null to clear the location (SCHEMA gov.meeting.location nullable).
  @BuiltValueField(wireName: r'location')
  String? get location;

  MeetingUpdate._();

  factory MeetingUpdate([void updates(MeetingUpdateBuilder b)]) = _$MeetingUpdate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MeetingUpdateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MeetingUpdate> get serializer => _$MeetingUpdateSerializer();
}

class _$MeetingUpdateSerializer implements PrimitiveSerializer<MeetingUpdate> {
  @override
  final Iterable<Type> types = const [MeetingUpdate, _$MeetingUpdate];

  @override
  final String wireName = r'MeetingUpdate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MeetingUpdate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    if (object.title != null) {
      yield r'title';
      yield serializers.serialize(
        object.title,
        specifiedType: const FullType(String),
      );
    }
    if (object.scheduledStart != null) {
      yield r'scheduled_start';
      yield serializers.serialize(
        object.scheduledStart,
        specifiedType: const FullType(DateTime),
      );
    }
    if (object.scheduledEnd != null) {
      yield r'scheduled_end';
      yield serializers.serialize(
        object.scheduledEnd,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    if (object.location != null) {
      yield r'location';
      yield serializers.serialize(
        object.location,
        specifiedType: const FullType.nullable(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    MeetingUpdate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MeetingUpdateBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'title':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.title = valueDes;
          break;
        case r'scheduled_start':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.scheduledStart = valueDes;
          break;
        case r'scheduled_end':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.scheduledEnd = valueDes;
          break;
        case r'location':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.location = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  MeetingUpdate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MeetingUpdateBuilder();
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

