//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_governance_http_client/src/model/invitation_recipient.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'invitation_recipient_page.g.dart';

/// One page of InvitationRecipient, in the list's stable server order.
///
/// Properties:
/// * [items] 
/// * [nextCursor] - Opaque cursor for the next page, or null at the end.
@BuiltValue()
abstract class InvitationRecipientPage implements Built<InvitationRecipientPage, InvitationRecipientPageBuilder> {
  @BuiltValueField(wireName: r'items')
  BuiltList<InvitationRecipient> get items;

  /// Opaque cursor for the next page, or null at the end.
  @BuiltValueField(wireName: r'nextCursor')
  String? get nextCursor;

  InvitationRecipientPage._();

  factory InvitationRecipientPage([void updates(InvitationRecipientPageBuilder b)]) = _$InvitationRecipientPage;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(InvitationRecipientPageBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<InvitationRecipientPage> get serializer => _$InvitationRecipientPageSerializer();
}

class _$InvitationRecipientPageSerializer implements PrimitiveSerializer<InvitationRecipientPage> {
  @override
  final Iterable<Type> types = const [InvitationRecipientPage, _$InvitationRecipientPage];

  @override
  final String wireName = r'InvitationRecipientPage';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    InvitationRecipientPage object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'items';
    yield serializers.serialize(
      object.items,
      specifiedType: const FullType(BuiltList, [FullType(InvitationRecipient)]),
    );
    yield r'nextCursor';
    yield object.nextCursor == null ? null : serializers.serialize(
      object.nextCursor,
      specifiedType: const FullType.nullable(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    InvitationRecipientPage object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required InvitationRecipientPageBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'items':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(InvitationRecipient)]),
          ) as BuiltList<InvitationRecipient>;
          result.items.replace(valueDes);
          break;
        case r'nextCursor':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.nextCursor = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  InvitationRecipientPage deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = InvitationRecipientPageBuilder();
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

