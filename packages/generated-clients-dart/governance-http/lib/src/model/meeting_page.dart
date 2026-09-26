//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_governance_http_client/src/model/meeting.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'meeting_page.g.dart';

/// One page of Meeting, in the list's stable server order.
///
/// Properties:
/// * [items] 
/// * [nextCursor] - Opaque cursor for the next page, or null at the end.
@BuiltValue()
abstract class MeetingPage implements Built<MeetingPage, MeetingPageBuilder> {
  @BuiltValueField(wireName: r'items')
  BuiltList<Meeting> get items;

  /// Opaque cursor for the next page, or null at the end.
  @BuiltValueField(wireName: r'nextCursor')
  String? get nextCursor;

  MeetingPage._();

  factory MeetingPage([void updates(MeetingPageBuilder b)]) = _$MeetingPage;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MeetingPageBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MeetingPage> get serializer => _$MeetingPageSerializer();
}

class _$MeetingPageSerializer implements PrimitiveSerializer<MeetingPage> {
  @override
  final Iterable<Type> types = const [MeetingPage, _$MeetingPage];

  @override
  final String wireName = r'MeetingPage';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MeetingPage object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'items';
    yield serializers.serialize(
      object.items,
      specifiedType: const FullType(BuiltList, [FullType(Meeting)]),
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
    MeetingPage object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MeetingPageBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'items':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(Meeting)]),
          ) as BuiltList<Meeting>;
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
  MeetingPage deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MeetingPageBuilder();
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

