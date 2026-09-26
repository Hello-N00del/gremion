//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'motion.g.dart';

/// Motion
///
/// Properties:
/// * [motionId] - DB-GOV-MOTION id (UUIDv7)
/// * [targetMeetingId] - The meeting this motion targets. Null while in draft, or after a deferral to the next meeting until one is chosen (SCHEMA gov.motion.target_meeting_id).
/// * [agendaItemId] 
/// * [referenceLabel] 
/// * [title] 
/// * [motionText] 
/// * [rationale] 
/// * [submitterKind] 
/// * [submitterPersonId] 
/// * [submittedAt] - Set by the server at submission or on verification. Null in draft, pending_verification and expired (SCHEMA motion_submitted_check).
/// * [deadlineSnapshot] - The meeting's motion deadline as it stood when the motion was submitted (DOMAIN DB-GOV-MOTION); is_late is computed from it on the server. Null while the motion is a draft.
/// * [isLate] - Computed on the server (submitted_at after deadline_snapshot). Never accepted from the client (PRD-MTG-003, FLOW-MTG-003 B1). Null while either side is null: before submission, or when the target meeting sets no motion deadline (SCHEMA generated column).
/// * [state] - DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
/// * [publicationClass] 
@BuiltValue()
abstract class Motion implements Built<Motion, MotionBuilder> {
  /// DB-GOV-MOTION id (UUIDv7)
  @BuiltValueField(wireName: r'motion_id')
  String get motionId;

  /// The meeting this motion targets. Null while in draft, or after a deferral to the next meeting until one is chosen (SCHEMA gov.motion.target_meeting_id).
  @BuiltValueField(wireName: r'target_meeting_id')
  String? get targetMeetingId;

  @BuiltValueField(wireName: r'agenda_item_id')
  String? get agendaItemId;

  @BuiltValueField(wireName: r'reference_label')
  String? get referenceLabel;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'motion_text')
  String get motionText;

  @BuiltValueField(wireName: r'rationale')
  String? get rationale;

  @BuiltValueField(wireName: r'submitter_kind')
  MotionSubmitterKindEnum get submitterKind;
  // enum submitterKindEnum {  member,  helper,  public,  };

  @BuiltValueField(wireName: r'submitter_person_id')
  String? get submitterPersonId;

  /// Set by the server at submission or on verification. Null in draft, pending_verification and expired (SCHEMA motion_submitted_check).
  @BuiltValueField(wireName: r'submitted_at')
  DateTime? get submittedAt;

  /// The meeting's motion deadline as it stood when the motion was submitted (DOMAIN DB-GOV-MOTION); is_late is computed from it on the server. Null while the motion is a draft.
  @BuiltValueField(wireName: r'deadline_snapshot')
  DateTime? get deadlineSnapshot;

  /// Computed on the server (submitted_at after deadline_snapshot). Never accepted from the client (PRD-MTG-003, FLOW-MTG-003 B1). Null while either side is null: before submission, or when the target meeting sets no motion deadline (SCHEMA generated column).
  @BuiltValueField(wireName: r'is_late')
  bool? get isLate;

  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueField(wireName: r'state')
  MotionStateEnum get state;
  // enum stateEnum {  draft,  pending_verification,  submitted,  on_agenda,  withheld,  deferred,  decided,  adjourned,  withdrawn,  expired,  };

  @BuiltValueField(wireName: r'publication_class')
  MotionPublicationClassEnum? get publicationClass;
  // enum publicationClassEnum {  public,  non_public,  };

  Motion._();

  factory Motion([void updates(MotionBuilder b)]) = _$Motion;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MotionBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Motion> get serializer => _$MotionSerializer();
}

class _$MotionSerializer implements PrimitiveSerializer<Motion> {
  @override
  final Iterable<Type> types = const [Motion, _$Motion];

  @override
  final String wireName = r'Motion';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Motion object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'motion_id';
    yield serializers.serialize(
      object.motionId,
      specifiedType: const FullType(String),
    );
    yield r'target_meeting_id';
    yield object.targetMeetingId == null ? null : serializers.serialize(
      object.targetMeetingId,
      specifiedType: const FullType.nullable(String),
    );
    if (object.agendaItemId != null) {
      yield r'agenda_item_id';
      yield serializers.serialize(
        object.agendaItemId,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.referenceLabel != null) {
      yield r'reference_label';
      yield serializers.serialize(
        object.referenceLabel,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'title';
    yield serializers.serialize(
      object.title,
      specifiedType: const FullType(String),
    );
    yield r'motion_text';
    yield serializers.serialize(
      object.motionText,
      specifiedType: const FullType(String),
    );
    if (object.rationale != null) {
      yield r'rationale';
      yield serializers.serialize(
        object.rationale,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'submitter_kind';
    yield serializers.serialize(
      object.submitterKind,
      specifiedType: const FullType(MotionSubmitterKindEnum),
    );
    if (object.submitterPersonId != null) {
      yield r'submitter_person_id';
      yield serializers.serialize(
        object.submitterPersonId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'submitted_at';
    yield object.submittedAt == null ? null : serializers.serialize(
      object.submittedAt,
      specifiedType: const FullType.nullable(DateTime),
    );
    if (object.deadlineSnapshot != null) {
      yield r'deadline_snapshot';
      yield serializers.serialize(
        object.deadlineSnapshot,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    yield r'is_late';
    yield object.isLate == null ? null : serializers.serialize(
      object.isLate,
      specifiedType: const FullType.nullable(bool),
    );
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(MotionStateEnum),
    );
    if (object.publicationClass != null) {
      yield r'publication_class';
      yield serializers.serialize(
        object.publicationClass,
        specifiedType: const FullType(MotionPublicationClassEnum),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    Motion object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MotionBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'motion_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.motionId = valueDes;
          break;
        case r'target_meeting_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.targetMeetingId = valueDes;
          break;
        case r'agenda_item_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.agendaItemId = valueDes;
          break;
        case r'reference_label':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.referenceLabel = valueDes;
          break;
        case r'title':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.title = valueDes;
          break;
        case r'motion_text':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.motionText = valueDes;
          break;
        case r'rationale':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.rationale = valueDes;
          break;
        case r'submitter_kind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(MotionSubmitterKindEnum),
          ) as MotionSubmitterKindEnum;
          result.submitterKind = valueDes;
          break;
        case r'submitter_person_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.submitterPersonId = valueDes;
          break;
        case r'submitted_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.submittedAt = valueDes;
          break;
        case r'deadline_snapshot':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.deadlineSnapshot = valueDes;
          break;
        case r'is_late':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(bool),
          ) as bool?;
          if (valueDes == null) continue;
          result.isLate = valueDes;
          break;
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(MotionStateEnum),
          ) as MotionStateEnum;
          result.state = valueDes;
          break;
        case r'publication_class':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(MotionPublicationClassEnum),
          ) as MotionPublicationClassEnum;
          result.publicationClass = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Motion deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MotionBuilder();
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

class MotionSubmitterKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'member')
  static const MotionSubmitterKindEnum member = _$motionSubmitterKindEnum_member;
  @BuiltValueEnumConst(wireName: r'helper')
  static const MotionSubmitterKindEnum helper = _$motionSubmitterKindEnum_helper;
  @BuiltValueEnumConst(wireName: r'public')
  static const MotionSubmitterKindEnum public = _$motionSubmitterKindEnum_public;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MotionSubmitterKindEnum unknownDefaultOpenApi = _$motionSubmitterKindEnum_unknownDefaultOpenApi;

  static Serializer<MotionSubmitterKindEnum> get serializer => _$motionSubmitterKindEnumSerializer;

  const MotionSubmitterKindEnum._(String name): super(name);

  static BuiltSet<MotionSubmitterKindEnum> get values => _$motionSubmitterKindEnumValues;
  static MotionSubmitterKindEnum valueOf(String name) => _$motionSubmitterKindEnumValueOf(name);
}

class MotionStateEnum extends EnumClass {

  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'draft')
  static const MotionStateEnum draft = _$motionStateEnum_draft;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'pending_verification')
  static const MotionStateEnum pendingVerification = _$motionStateEnum_pendingVerification;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'submitted')
  static const MotionStateEnum submitted = _$motionStateEnum_submitted;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'on_agenda')
  static const MotionStateEnum onAgenda = _$motionStateEnum_onAgenda;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'withheld')
  static const MotionStateEnum withheld = _$motionStateEnum_withheld;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'deferred')
  static const MotionStateEnum deferred_ = _$motionStateEnum_deferred_;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'decided')
  static const MotionStateEnum decided = _$motionStateEnum_decided;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'adjourned')
  static const MotionStateEnum adjourned = _$motionStateEnum_adjourned;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'withdrawn')
  static const MotionStateEnum withdrawn = _$motionStateEnum_withdrawn;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'expired')
  static const MotionStateEnum expired = _$motionStateEnum_expired;
  /// DOMAIN Motion lifecycle (PRD-MTG-003, FLOW-MTG-003). withheld = submitted after the deadline and marked late, off the agenda until an admission; pending_verification and expired belong to public intake, which stays off per body (DOMAIN GOV question 1).
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MotionStateEnum unknownDefaultOpenApi = _$motionStateEnum_unknownDefaultOpenApi;

  static Serializer<MotionStateEnum> get serializer => _$motionStateEnumSerializer;

  const MotionStateEnum._(String name): super(name);

  static BuiltSet<MotionStateEnum> get values => _$motionStateEnumValues;
  static MotionStateEnum valueOf(String name) => _$motionStateEnumValueOf(name);
}

class MotionPublicationClassEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'public')
  static const MotionPublicationClassEnum public = _$motionPublicationClassEnum_public;
  @BuiltValueEnumConst(wireName: r'non_public')
  static const MotionPublicationClassEnum nonPublic = _$motionPublicationClassEnum_nonPublic;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MotionPublicationClassEnum unknownDefaultOpenApi = _$motionPublicationClassEnum_unknownDefaultOpenApi;

  static Serializer<MotionPublicationClassEnum> get serializer => _$motionPublicationClassEnumSerializer;

  const MotionPublicationClassEnum._(String name): super(name);

  static BuiltSet<MotionPublicationClassEnum> get values => _$motionPublicationClassEnumValues;
  static MotionPublicationClassEnum valueOf(String name) => _$motionPublicationClassEnumValueOf(name);
}

