//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'notice_override.g.dart';

/// Append-only (PRD-MTG-002b / DOMAIN [D R20-D26-5]). No PUT/PATCH/DELETE exists for this resource — at most one per invitation, and it can never be undone or edited.
///
/// Properties:
/// * [overrideId] - DB-GOV-NOTICE-OVERRIDE id (bigint, carried as a string to avoid JS precision loss)
/// * [invitationId] - The invitation this override justifies
/// * [meetingId] - Owning meeting
/// * [actorPersonId] 
/// * [overriddenAt] 
/// * [daysShort] 
/// * [reason] - Required at insert (NoticeOverrideCreate). Null only after it was erased in place under a covered redaction (SCHEMA notice_override_erased_check). Never carried in an event payload.
/// * [curingBasisId] 
/// * [curingBasisVersion] 
/// * [curingBasisSnapshot] - The curing basis text and citation as they stood when the override was recorded (DOMAIN DB-GOV-NOTICE-OVERRIDE); server-written, so a later change to the body's basis never changes a recorded override. Null when no curing basis was referenced.
@BuiltValue()
abstract class NoticeOverride implements Built<NoticeOverride, NoticeOverrideBuilder> {
  /// DB-GOV-NOTICE-OVERRIDE id (bigint, carried as a string to avoid JS precision loss)
  @BuiltValueField(wireName: r'override_id')
  String get overrideId;

  /// The invitation this override justifies
  @BuiltValueField(wireName: r'invitation_id')
  String get invitationId;

  /// Owning meeting
  @BuiltValueField(wireName: r'meeting_id')
  String get meetingId;

  @BuiltValueField(wireName: r'actor_person_id')
  String get actorPersonId;

  @BuiltValueField(wireName: r'overridden_at')
  DateTime get overriddenAt;

  @BuiltValueField(wireName: r'days_short')
  int get daysShort;

  /// Required at insert (NoticeOverrideCreate). Null only after it was erased in place under a covered redaction (SCHEMA notice_override_erased_check). Never carried in an event payload.
  @BuiltValueField(wireName: r'reason')
  String? get reason;

  @BuiltValueField(wireName: r'curing_basis_id')
  String? get curingBasisId;

  @BuiltValueField(wireName: r'curing_basis_version')
  int? get curingBasisVersion;

  /// The curing basis text and citation as they stood when the override was recorded (DOMAIN DB-GOV-NOTICE-OVERRIDE); server-written, so a later change to the body's basis never changes a recorded override. Null when no curing basis was referenced.
  @BuiltValueField(wireName: r'curing_basis_snapshot')
  String? get curingBasisSnapshot;

  NoticeOverride._();

  factory NoticeOverride([void updates(NoticeOverrideBuilder b)]) = _$NoticeOverride;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(NoticeOverrideBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<NoticeOverride> get serializer => _$NoticeOverrideSerializer();
}

class _$NoticeOverrideSerializer implements PrimitiveSerializer<NoticeOverride> {
  @override
  final Iterable<Type> types = const [NoticeOverride, _$NoticeOverride];

  @override
  final String wireName = r'NoticeOverride';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    NoticeOverride object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'override_id';
    yield serializers.serialize(
      object.overrideId,
      specifiedType: const FullType(String),
    );
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
    yield r'actor_person_id';
    yield serializers.serialize(
      object.actorPersonId,
      specifiedType: const FullType(String),
    );
    yield r'overridden_at';
    yield serializers.serialize(
      object.overriddenAt,
      specifiedType: const FullType(DateTime),
    );
    yield r'days_short';
    yield serializers.serialize(
      object.daysShort,
      specifiedType: const FullType(int),
    );
    yield r'reason';
    yield object.reason == null ? null : serializers.serialize(
      object.reason,
      specifiedType: const FullType.nullable(String),
    );
    if (object.curingBasisId != null) {
      yield r'curing_basis_id';
      yield serializers.serialize(
        object.curingBasisId,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.curingBasisVersion != null) {
      yield r'curing_basis_version';
      yield serializers.serialize(
        object.curingBasisVersion,
        specifiedType: const FullType.nullable(int),
      );
    }
    if (object.curingBasisSnapshot != null) {
      yield r'curing_basis_snapshot';
      yield serializers.serialize(
        object.curingBasisSnapshot,
        specifiedType: const FullType.nullable(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    NoticeOverride object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required NoticeOverrideBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'override_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.overrideId = valueDes;
          break;
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
        case r'actor_person_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.actorPersonId = valueDes;
          break;
        case r'overridden_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.overriddenAt = valueDes;
          break;
        case r'days_short':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.daysShort = valueDes;
          break;
        case r'reason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.reason = valueDes;
          break;
        case r'curing_basis_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.curingBasisId = valueDes;
          break;
        case r'curing_basis_version':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(int),
          ) as int?;
          if (valueDes == null) continue;
          result.curingBasisVersion = valueDes;
          break;
        case r'curing_basis_snapshot':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.curingBasisSnapshot = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  NoticeOverride deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = NoticeOverrideBuilder();
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

