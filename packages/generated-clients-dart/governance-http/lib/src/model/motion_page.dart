//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_governance_http_client/src/model/motion.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'motion_page.g.dart';

/// One page of Motion, in the list's stable server order.
///
/// Properties:
/// * [items] 
/// * [nextCursor] - Opaque cursor for the next page, or null at the end.
@BuiltValue()
abstract class MotionPage implements Built<MotionPage, MotionPageBuilder> {
  @BuiltValueField(wireName: r'items')
  BuiltList<Motion> get items;

  /// Opaque cursor for the next page, or null at the end.
  @BuiltValueField(wireName: r'nextCursor')
  String? get nextCursor;

  MotionPage._();

  factory MotionPage([void updates(MotionPageBuilder b)]) = _$MotionPage;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MotionPageBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MotionPage> get serializer => _$MotionPageSerializer();
}

class _$MotionPageSerializer implements PrimitiveSerializer<MotionPage> {
  @override
  final Iterable<Type> types = const [MotionPage, _$MotionPage];

  @override
  final String wireName = r'MotionPage';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MotionPage object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'items';
    yield serializers.serialize(
      object.items,
      specifiedType: const FullType(BuiltList, [FullType(Motion)]),
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
    MotionPage object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MotionPageBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'items':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(Motion)]),
          ) as BuiltList<Motion>;
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
  MotionPage deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MotionPageBuilder();
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

