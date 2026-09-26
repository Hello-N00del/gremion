//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'invitation.g.dart';

/// Invitation
///
/// Properties:
/// * [invitationId] - DB-GOV-INVITATION id (UUIDv7, one per version)
/// * [meetingId] - Owning meeting
/// * [version] 
/// * [agendaSnapshotId] - Frozen agenda snapshot (bigint, carried as a string to avoid JS precision loss)
/// * [state] - DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
/// * [noticeMet] - Set by the notice check; null while the invitation is draft or checked (SCHEMA invitation_notice_met_check). false is a flag, never a block: dispatch then needs the one notice override (PRD-MTG-002b).
/// * [sentAt] 
/// * [senderPersonId] - Opaque person reference of the chair who issued the invitation (DOMAIN DB-GOV-INVITATION); null until sent.
/// * [recipientCount] - Number of recipients at dispatch; null before dispatch (SCHEMA gov.invitation.recipient_count nullable).
@BuiltValue()
abstract class Invitation implements Built<Invitation, InvitationBuilder> {
  /// DB-GOV-INVITATION id (UUIDv7, one per version)
  @BuiltValueField(wireName: r'invitation_id')
  String get invitationId;

  /// Owning meeting
  @BuiltValueField(wireName: r'meeting_id')
  String get meetingId;

  @BuiltValueField(wireName: r'version')
  int get version;

  /// Frozen agenda snapshot (bigint, carried as a string to avoid JS precision loss)
  @BuiltValueField(wireName: r'agenda_snapshot_id')
  String? get agendaSnapshotId;

  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueField(wireName: r'state')
  InvitationStateEnum get state;
  // enum stateEnum {  draft,  checked,  blocked,  override_logged,  dispatching,  dispatch_refused,  sent,  partly_failed,  };

  /// Set by the notice check; null while the invitation is draft or checked (SCHEMA invitation_notice_met_check). false is a flag, never a block: dispatch then needs the one notice override (PRD-MTG-002b).
  @BuiltValueField(wireName: r'notice_met')
  bool? get noticeMet;

  @BuiltValueField(wireName: r'sent_at')
  DateTime? get sentAt;

  /// Opaque person reference of the chair who issued the invitation (DOMAIN DB-GOV-INVITATION); null until sent.
  @BuiltValueField(wireName: r'sender_person_id')
  String? get senderPersonId;

  /// Number of recipients at dispatch; null before dispatch (SCHEMA gov.invitation.recipient_count nullable).
  @BuiltValueField(wireName: r'recipient_count')
  int? get recipientCount;

  Invitation._();

  factory Invitation([void updates(InvitationBuilder b)]) = _$Invitation;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(InvitationBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Invitation> get serializer => _$InvitationSerializer();
}

class _$InvitationSerializer implements PrimitiveSerializer<Invitation> {
  @override
  final Iterable<Type> types = const [Invitation, _$Invitation];

  @override
  final String wireName = r'Invitation';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Invitation object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'invitation_id';
    yield serializers.serialize(
      object.invitationId,
      specifiedType: const FullType(String),
    );
    yield r'meeting_id';
    yield serializers.serialize(
      object.meetingId,
      specifiedType: const FullType(String),
    );
    yield r'version';
    yield serializers.serialize(
      object.version,
      specifiedType: const FullType(int),
    );
    if (object.agendaSnapshotId != null) {
      yield r'agenda_snapshot_id';
      yield serializers.serialize(
        object.agendaSnapshotId,
        specifiedType: const FullType(String),
      );
    }
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(InvitationStateEnum),
    );
    yield r'notice_met';
    yield object.noticeMet == null ? null : serializers.serialize(
      object.noticeMet,
      specifiedType: const FullType.nullable(bool),
    );
    if (object.sentAt != null) {
      yield r'sent_at';
      yield serializers.serialize(
        object.sentAt,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    if (object.senderPersonId != null) {
      yield r'sender_person_id';
      yield serializers.serialize(
        object.senderPersonId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'recipient_count';
    yield object.recipientCount == null ? null : serializers.serialize(
      object.recipientCount,
      specifiedType: const FullType.nullable(int),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Invitation object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required InvitationBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'invitation_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.invitationId = valueDes;
          break;
        case r'meeting_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.meetingId = valueDes;
          break;
        case r'version':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.version = valueDes;
          break;
        case r'agenda_snapshot_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.agendaSnapshotId = valueDes;
          break;
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(InvitationStateEnum),
          ) as InvitationStateEnum;
          result.state = valueDes;
          break;
        case r'notice_met':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(bool),
          ) as bool?;
          if (valueDes == null) continue;
          result.noticeMet = valueDes;
          break;
        case r'sent_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.sentAt = valueDes;
          break;
        case r'sender_person_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.senderPersonId = valueDes;
          break;
        case r'recipient_count':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(int),
          ) as int?;
          if (valueDes == null) continue;
          result.recipientCount = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Invitation deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = InvitationBuilder();
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

class InvitationStateEnum extends EnumClass {

  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'draft')
  static const InvitationStateEnum draft = _$invitationStateEnum_draft;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'checked')
  static const InvitationStateEnum checked = _$invitationStateEnum_checked;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'blocked')
  static const InvitationStateEnum blocked = _$invitationStateEnum_blocked;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'override_logged')
  static const InvitationStateEnum overrideLogged = _$invitationStateEnum_overrideLogged;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'dispatching')
  static const InvitationStateEnum dispatching = _$invitationStateEnum_dispatching;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'dispatch_refused')
  static const InvitationStateEnum dispatchRefused = _$invitationStateEnum_dispatchRefused;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'sent')
  static const InvitationStateEnum sent = _$invitationStateEnum_sent;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'partly_failed')
  static const InvitationStateEnum partlyFailed = _$invitationStateEnum_partlyFailed;
  /// DOMAIN Invitation lifecycle (PRD-MTG-002a/002b, FLOW-MTG-002). blocked = notice not met and no override yet; override_logged = the one notice-override is recorded; dispatch_refused = MAIL reports no connector for the body; partly_failed = some recipients failed or bounced. A blocked invitation never blocks the Sitzung [D R20-D26-5].
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const InvitationStateEnum unknownDefaultOpenApi = _$invitationStateEnum_unknownDefaultOpenApi;

  static Serializer<InvitationStateEnum> get serializer => _$invitationStateEnumSerializer;

  const InvitationStateEnum._(String name): super(name);

  static BuiltSet<InvitationStateEnum> get values => _$invitationStateEnumValues;
  static InvitationStateEnum valueOf(String name) => _$invitationStateEnumValueOf(name);
}

