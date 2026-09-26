//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'invitation_recipient.g.dart';

/// No address or email property is ever exposed — the evidence itself lives only in MAIL's DB-MAIL-DELIVERYEVIDENCE (DOMAIN DB-GOV-INVITATION-RECIPIENT invariant, D-nc memo D26).
///
/// Properties:
/// * [recipientId] - DB-GOV-INVITATION-RECIPIENT id (UUIDv7; crosses to MAIL as recipient_reference)
/// * [invitationId] - Owning invitation
/// * [personId] 
/// * [deliveryState] 
/// * [bounceClass] 
/// * [submittedAt] 
/// * [inAppDelivered] 
@BuiltValue()
abstract class InvitationRecipient implements Built<InvitationRecipient, InvitationRecipientBuilder> {
  /// DB-GOV-INVITATION-RECIPIENT id (UUIDv7; crosses to MAIL as recipient_reference)
  @BuiltValueField(wireName: r'recipient_id')
  String get recipientId;

  /// Owning invitation
  @BuiltValueField(wireName: r'invitation_id')
  String get invitationId;

  @BuiltValueField(wireName: r'person_id')
  String get personId;

  @BuiltValueField(wireName: r'delivery_state')
  InvitationRecipientDeliveryStateEnum get deliveryState;
  // enum deliveryStateEnum {  queued,  submitted,  failed,  bounced,  no_connector,  };

  @BuiltValueField(wireName: r'bounce_class')
  String? get bounceClass;

  @BuiltValueField(wireName: r'submitted_at')
  DateTime? get submittedAt;

  @BuiltValueField(wireName: r'in_app_delivered')
  bool? get inAppDelivered;

  InvitationRecipient._();

  factory InvitationRecipient([void updates(InvitationRecipientBuilder b)]) = _$InvitationRecipient;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(InvitationRecipientBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<InvitationRecipient> get serializer => _$InvitationRecipientSerializer();
}

class _$InvitationRecipientSerializer implements PrimitiveSerializer<InvitationRecipient> {
  @override
  final Iterable<Type> types = const [InvitationRecipient, _$InvitationRecipient];

  @override
  final String wireName = r'InvitationRecipient';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    InvitationRecipient object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'recipient_id';
    yield serializers.serialize(
      object.recipientId,
      specifiedType: const FullType(String),
    );
    yield r'invitation_id';
    yield serializers.serialize(
      object.invitationId,
      specifiedType: const FullType(String),
    );
    yield r'person_id';
    yield serializers.serialize(
      object.personId,
      specifiedType: const FullType(String),
    );
    yield r'delivery_state';
    yield serializers.serialize(
      object.deliveryState,
      specifiedType: const FullType(InvitationRecipientDeliveryStateEnum),
    );
    if (object.bounceClass != null) {
      yield r'bounce_class';
      yield serializers.serialize(
        object.bounceClass,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.submittedAt != null) {
      yield r'submitted_at';
      yield serializers.serialize(
        object.submittedAt,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
    if (object.inAppDelivered != null) {
      yield r'in_app_delivered';
      yield serializers.serialize(
        object.inAppDelivered,
        specifiedType: const FullType(bool),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    InvitationRecipient object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required InvitationRecipientBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'recipient_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.recipientId = valueDes;
          break;
        case r'invitation_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.invitationId = valueDes;
          break;
        case r'person_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.personId = valueDes;
          break;
        case r'delivery_state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(InvitationRecipientDeliveryStateEnum),
          ) as InvitationRecipientDeliveryStateEnum;
          result.deliveryState = valueDes;
          break;
        case r'bounce_class':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.bounceClass = valueDes;
          break;
        case r'submitted_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.submittedAt = valueDes;
          break;
        case r'in_app_delivered':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.inAppDelivered = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  InvitationRecipient deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = InvitationRecipientBuilder();
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

class InvitationRecipientDeliveryStateEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'queued')
  static const InvitationRecipientDeliveryStateEnum queued = _$invitationRecipientDeliveryStateEnum_queued;
  @BuiltValueEnumConst(wireName: r'submitted')
  static const InvitationRecipientDeliveryStateEnum submitted = _$invitationRecipientDeliveryStateEnum_submitted;
  @BuiltValueEnumConst(wireName: r'failed')
  static const InvitationRecipientDeliveryStateEnum failed = _$invitationRecipientDeliveryStateEnum_failed;
  @BuiltValueEnumConst(wireName: r'bounced')
  static const InvitationRecipientDeliveryStateEnum bounced = _$invitationRecipientDeliveryStateEnum_bounced;
  @BuiltValueEnumConst(wireName: r'no_connector')
  static const InvitationRecipientDeliveryStateEnum noConnector = _$invitationRecipientDeliveryStateEnum_noConnector;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const InvitationRecipientDeliveryStateEnum unknownDefaultOpenApi = _$invitationRecipientDeliveryStateEnum_unknownDefaultOpenApi;

  static Serializer<InvitationRecipientDeliveryStateEnum> get serializer => _$invitationRecipientDeliveryStateEnumSerializer;

  const InvitationRecipientDeliveryStateEnum._(String name): super(name);

  static BuiltSet<InvitationRecipientDeliveryStateEnum> get values => _$invitationRecipientDeliveryStateEnumValues;
  static InvitationRecipientDeliveryStateEnum valueOf(String name) => _$invitationRecipientDeliveryStateEnumValueOf(name);
}

