//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'meeting.g.dart';

/// Meeting
///
/// Properties:
/// * [meetingId] - DB-GOV-MEETING id (UUIDv7)
/// * [bodyId] - Opaque IDT body reference
/// * [orgUnitId] - Opaque IDT org-unit reference: the deciding organ. Null where the body itself decides (DOMAIN DB-GOV organisational references; SCHEMA gov.meeting.org_unit_id nullable).
/// * [wahlperiodeId] - Opaque IDT Wahlperiode reference (TRD-086). A mismatch with the body's current Wahlperiode warns and never blocks [D R17-14].
/// * [meetingNumber] - Serves the meeting_number token of the register numbering scheme. Null until numbered (SCHEMA gov.meeting.meeting_number nullable).
/// * [title] - DB-GOV-MEETING.title. Served here (gov.meeting-read v1) and deliberately never carried in event payloads (DOMAIN GOV events table).
/// * [scheduledStart] 
/// * [scheduledEnd] - Null when no end is set (SCHEMA gov.meeting.scheduled_end nullable).
/// * [location] - Free text; null when no location is set (SCHEMA gov.meeting.location nullable).
/// * [callLinkId] - Display-only projection of msg.calllink.set.v1. MSG owns the meeting-to-call association; GOV never writes it except from MSG's event.
/// * [state] - DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
/// * [noticePeriodDaysSnapshot] - Ladungsfrist in days, snapshotted from the body's governance settings when the meeting was planned; later settings changes never alter it (DB-GOV-MEETING invariant).
/// * [noticeDueAt] 
/// * [motionDeadlineAt] - Snapshotted from the body's motion deadline offset when the meeting was planned. Null when the body sets no motion deadline (SCHEMA gov.meeting.motion_deadline_at nullable).
/// * [openedAt] 
/// * [closedAt] 
/// * [cancelReason] - Set exactly when state is cancelled, null otherwise (SCHEMA meeting_cancelled_check). Why the meeting was cancelled: the chair cancelled it, the body or the org unit was archived, or the customer is being offboarded. Values are SCHEMA meeting_cancel_reason_check.
@BuiltValue()
abstract class Meeting implements Built<Meeting, MeetingBuilder> {
  /// DB-GOV-MEETING id (UUIDv7)
  @BuiltValueField(wireName: r'meeting_id')
  String get meetingId;

  /// Opaque IDT body reference
  @BuiltValueField(wireName: r'body_id')
  String get bodyId;

  /// Opaque IDT org-unit reference: the deciding organ. Null where the body itself decides (DOMAIN DB-GOV organisational references; SCHEMA gov.meeting.org_unit_id nullable).
  @BuiltValueField(wireName: r'org_unit_id')
  String? get orgUnitId;

  /// Opaque IDT Wahlperiode reference (TRD-086). A mismatch with the body's current Wahlperiode warns and never blocks [D R17-14].
  @BuiltValueField(wireName: r'wahlperiode_id')
  String? get wahlperiodeId;

  /// Serves the meeting_number token of the register numbering scheme. Null until numbered (SCHEMA gov.meeting.meeting_number nullable).
  @BuiltValueField(wireName: r'meeting_number')
  int? get meetingNumber;

  /// DB-GOV-MEETING.title. Served here (gov.meeting-read v1) and deliberately never carried in event payloads (DOMAIN GOV events table).
  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'scheduled_start')
  DateTime get scheduledStart;

  /// Null when no end is set (SCHEMA gov.meeting.scheduled_end nullable).
  @BuiltValueField(wireName: r'scheduled_end')
  DateTime? get scheduledEnd;

  /// Free text; null when no location is set (SCHEMA gov.meeting.location nullable).
  @BuiltValueField(wireName: r'location')
  String? get location;

  /// Display-only projection of msg.calllink.set.v1. MSG owns the meeting-to-call association; GOV never writes it except from MSG's event.
  @BuiltValueField(wireName: r'call_link_id')
  String? get callLinkId;

  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueField(wireName: r'state')
  MeetingStateEnum get state;
  // enum stateEnum {  planned,  invited,  in_session,  suspended,  closed,  cancelled,  };

  /// Ladungsfrist in days, snapshotted from the body's governance settings when the meeting was planned; later settings changes never alter it (DB-GOV-MEETING invariant).
  @BuiltValueField(wireName: r'notice_period_days_snapshot')
  int get noticePeriodDaysSnapshot;

  @BuiltValueField(wireName: r'notice_due_at')
  DateTime get noticeDueAt;

  /// Snapshotted from the body's motion deadline offset when the meeting was planned. Null when the body sets no motion deadline (SCHEMA gov.meeting.motion_deadline_at nullable).
  @BuiltValueField(wireName: r'motion_deadline_at')
  DateTime? get motionDeadlineAt;

  @BuiltValueField(wireName: r'opened_at')
  DateTime? get openedAt;

  @BuiltValueField(wireName: r'closed_at')
  DateTime? get closedAt;

  /// Set exactly when state is cancelled, null otherwise (SCHEMA meeting_cancelled_check). Why the meeting was cancelled: the chair cancelled it, the body or the org unit was archived, or the customer is being offboarded. Values are SCHEMA meeting_cancel_reason_check.
  @BuiltValueField(wireName: r'cancel_reason')
  MeetingCancelReasonEnum? get cancelReason;
  // enum cancelReasonEnum {  chair_cancelled,  body_archived,  org_unit_archived,  customer_offboarding,  };

  Meeting._();

  factory Meeting([void updates(MeetingBuilder b)]) = _$Meeting;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MeetingBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Meeting> get serializer => _$MeetingSerializer();
}

class _$MeetingSerializer implements PrimitiveSerializer<Meeting> {
  @override
  final Iterable<Type> types = const [Meeting, _$Meeting];

  @override
  final String wireName = r'Meeting';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Meeting object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'meeting_id';
    yield serializers.serialize(
      object.meetingId,
      specifiedType: const FullType(String),
    );
    yield r'body_id';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'org_unit_id';
    yield object.orgUnitId == null ? null : serializers.serialize(
      object.orgUnitId,
      specifiedType: const FullType.nullable(String),
    );
    if (object.wahlperiodeId != null) {
      yield r'wahlperiode_id';
      yield serializers.serialize(
        object.wahlperiodeId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'meeting_number';
    yield object.meetingNumber == null ? null : serializers.serialize(
      object.meetingNumber,
      specifiedType: const FullType.nullable(int),
    );
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
    yield r'scheduled_end';
    yield object.scheduledEnd == null ? null : serializers.serialize(
      object.scheduledEnd,
      specifiedType: const FullType.nullable(DateTime),
    );
    if (object.location != null) {
      yield r'location';
      yield serializers.serialize(
        object.location,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.callLinkId != null) {
      yield r'call_link_id';
      yield serializers.serialize(
        object.callLinkId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(MeetingStateEnum),
    );
    yield r'notice_period_days_snapshot';
    yield serializers.serialize(
      object.noticePeriodDaysSnapshot,
      specifiedType: const FullType(int),
    );
    yield r'notice_due_at';
    yield serializers.serialize(
      object.noticeDueAt,
      specifiedType: const FullType(DateTime),
    );
    if (object.motionDeadlineAt != null) {
      yield r'motion_deadline_at';
      yield serializers.serialize(
        object.motionDeadlineAt,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    if (object.openedAt != null) {
      yield r'opened_at';
      yield serializers.serialize(
        object.openedAt,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    if (object.closedAt != null) {
      yield r'closed_at';
      yield serializers.serialize(
        object.closedAt,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    if (object.cancelReason != null) {
      yield r'cancel_reason';
      yield serializers.serialize(
        object.cancelReason,
        specifiedType: const FullType.nullable(MeetingCancelReasonEnum),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    Meeting object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MeetingBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'meeting_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.meetingId = valueDes;
          break;
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
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.wahlperiodeId = valueDes;
          break;
        case r'meeting_number':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(int),
          ) as int?;
          if (valueDes == null) continue;
          result.meetingNumber = valueDes;
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
        case r'call_link_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.callLinkId = valueDes;
          break;
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(MeetingStateEnum),
          ) as MeetingStateEnum;
          result.state = valueDes;
          break;
        case r'notice_period_days_snapshot':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.noticePeriodDaysSnapshot = valueDes;
          break;
        case r'notice_due_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.noticeDueAt = valueDes;
          break;
        case r'motion_deadline_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.motionDeadlineAt = valueDes;
          break;
        case r'opened_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.openedAt = valueDes;
          break;
        case r'closed_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.closedAt = valueDes;
          break;
        case r'cancel_reason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(MeetingCancelReasonEnum),
          ) as MeetingCancelReasonEnum?;
          if (valueDes == null) continue;
          result.cancelReason = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Meeting deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MeetingBuilder();
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

class MeetingStateEnum extends EnumClass {

  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueEnumConst(wireName: r'planned')
  static const MeetingStateEnum planned = _$meetingStateEnum_planned;
  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueEnumConst(wireName: r'invited')
  static const MeetingStateEnum invited = _$meetingStateEnum_invited;
  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueEnumConst(wireName: r'in_session')
  static const MeetingStateEnum inSession = _$meetingStateEnum_inSession;
  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueEnumConst(wireName: r'suspended')
  static const MeetingStateEnum suspended = _$meetingStateEnum_suspended;
  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueEnumConst(wireName: r'closed')
  static const MeetingStateEnum closed = _$meetingStateEnum_closed;
  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueEnumConst(wireName: r'cancelled')
  static const MeetingStateEnum cancelled = _$meetingStateEnum_cancelled;
  /// DOMAIN Meeting lifecycle. Moves only by that lifecycle (DB-GOV-MEETING invariant).
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MeetingStateEnum unknownDefaultOpenApi = _$meetingStateEnum_unknownDefaultOpenApi;

  static Serializer<MeetingStateEnum> get serializer => _$meetingStateEnumSerializer;

  const MeetingStateEnum._(String name): super(name);

  static BuiltSet<MeetingStateEnum> get values => _$meetingStateEnumValues;
  static MeetingStateEnum valueOf(String name) => _$meetingStateEnumValueOf(name);
}

class MeetingCancelReasonEnum extends EnumClass {

  /// Set exactly when state is cancelled, null otherwise (SCHEMA meeting_cancelled_check). Why the meeting was cancelled: the chair cancelled it, the body or the org unit was archived, or the customer is being offboarded. Values are SCHEMA meeting_cancel_reason_check.
  @BuiltValueEnumConst(wireName: r'chair_cancelled')
  static const MeetingCancelReasonEnum chairCancelled = _$meetingCancelReasonEnum_chairCancelled;
  /// Set exactly when state is cancelled, null otherwise (SCHEMA meeting_cancelled_check). Why the meeting was cancelled: the chair cancelled it, the body or the org unit was archived, or the customer is being offboarded. Values are SCHEMA meeting_cancel_reason_check.
  @BuiltValueEnumConst(wireName: r'body_archived')
  static const MeetingCancelReasonEnum bodyArchived = _$meetingCancelReasonEnum_bodyArchived;
  /// Set exactly when state is cancelled, null otherwise (SCHEMA meeting_cancelled_check). Why the meeting was cancelled: the chair cancelled it, the body or the org unit was archived, or the customer is being offboarded. Values are SCHEMA meeting_cancel_reason_check.
  @BuiltValueEnumConst(wireName: r'org_unit_archived')
  static const MeetingCancelReasonEnum orgUnitArchived = _$meetingCancelReasonEnum_orgUnitArchived;
  /// Set exactly when state is cancelled, null otherwise (SCHEMA meeting_cancelled_check). Why the meeting was cancelled: the chair cancelled it, the body or the org unit was archived, or the customer is being offboarded. Values are SCHEMA meeting_cancel_reason_check.
  @BuiltValueEnumConst(wireName: r'customer_offboarding')
  static const MeetingCancelReasonEnum customerOffboarding = _$meetingCancelReasonEnum_customerOffboarding;
  /// Set exactly when state is cancelled, null otherwise (SCHEMA meeting_cancelled_check). Why the meeting was cancelled: the chair cancelled it, the body or the org unit was archived, or the customer is being offboarded. Values are SCHEMA meeting_cancel_reason_check.
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MeetingCancelReasonEnum unknownDefaultOpenApi = _$meetingCancelReasonEnum_unknownDefaultOpenApi;

  static Serializer<MeetingCancelReasonEnum> get serializer => _$meetingCancelReasonEnumSerializer;

  const MeetingCancelReasonEnum._(String name): super(name);

  static BuiltSet<MeetingCancelReasonEnum> get values => _$meetingCancelReasonEnumValues;
  static MeetingCancelReasonEnum valueOf(String name) => _$meetingCancelReasonEnumValueOf(name);
}

