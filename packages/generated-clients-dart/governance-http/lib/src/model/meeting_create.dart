//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'meeting_create.g.dart';

/// MeetingCreate
///
/// Properties:
/// * [bodyId] - Opaque IDT body reference. Immutable once the meeting exists (DOMAIN DB-GOV-MEETING invariant). The tenant still comes from the host and token, never from here (TRD-409).
/// * [orgUnitId] - Opaque IDT org-unit reference of the deciding organ inside body_id. Omit or send null where the body itself decides (DOMAIN DB-GOV organisational references).
/// * [wahlperiodeId] - Opaque IDT Wahlperiode reference. Optional: when omitted the server records the body's current Wahlperiode [A]. A mismatch warns and never blocks [D R17-14].
/// * [title] - DB-GOV-MEETING.title.
/// * [scheduledStart] 
/// * [scheduledEnd] - Optional (SCHEMA gov.meeting.scheduled_end nullable). When given it must lie after scheduled_start (meeting_scheduled_end_check).
/// * [location] 
@BuiltValue()
abstract class MeetingCreate implements Built<MeetingCreate, MeetingCreateBuilder> {
  /// Opaque IDT body reference. Immutable once the meeting exists (DOMAIN DB-GOV-MEETING invariant). The tenant still comes from the host and token, never from here (TRD-409).
  @BuiltValueField(wireName: r'body_id')
  String get bodyId;

  /// Opaque IDT org-unit reference of the deciding organ inside body_id. Omit or send null where the body itself decides (DOMAIN DB-GOV organisational references).
  @BuiltValueField(wireName: r'org_unit_id')
  String? get orgUnitId;

  /// Opaque IDT Wahlperiode reference. Optional: when omitted the server records the body's current Wahlperiode [A]. A mismatch warns and never blocks [D R17-14].
  @BuiltValueField(wireName: r'wahlperiode_id')
  String? get wahlperiodeId;

  /// DB-GOV-MEETING.title.
  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'scheduled_start')
  DateTime get scheduledStart;

  /// Optional (SCHEMA gov.meeting.scheduled_end nullable). When given it must lie after scheduled_start (meeting_scheduled_end_check).
  @BuiltValueField(wireName: r'scheduled_end')
  DateTime? get scheduledEnd;

  @BuiltValueField(wireName: r'location')
  String? get location;

  MeetingCreate._();

  factory MeetingCreate([void updates(MeetingCreateBuilder b)]) = _$MeetingCreate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MeetingCreateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MeetingCreate> get serializer => _$MeetingCreateSerializer();
}

class _$MeetingCreateSerializer implements PrimitiveSerializer<MeetingCreate> {
  @override
  final Iterable<Type> types = const [MeetingCreate, _$MeetingCreate];

  @override
  final String wireName = r'MeetingCreate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MeetingCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'body_id';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    if (object.orgUnitId != null) {
      yield r'org_unit_id';
      yield serializers.serialize(
        object.orgUnitId,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.wahlperiodeId != null) {
      yield r'wahlperiode_id';
      yield serializers.serialize(
        object.wahlperiodeId,
        specifiedType: const FullType(String),
      );
    }
    yield r'title';
    yield serializers.serialize(
      object.title,
      specifiedType: const FullType(String),
    );
    yield r'scheduled_start';
    yield serializers.serialize(
      object.scheduledStart,
      specifiedType: const FullType(DateTime),
    );
    if (object.scheduledEnd != null) {
      yield r'scheduled_end';
      yield serializers.serialize(
        object.scheduledEnd,
        specifiedType: const FullType(DateTime),
      );
    }
    if (object.location != null) {
      yield r'location';
      yield serializers.serialize(
        object.location,
        specifiedType: const FullType(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    MeetingCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MeetingCreateBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'body_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'org_unit_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.orgUnitId = valueDes;
          break;
        case r'wahlperiode_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.wahlperiodeId = valueDes;
          break;
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
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.scheduledEnd = valueDes;
          break;
        case r'location':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
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
  MeetingCreate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MeetingCreateBuilder();
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

