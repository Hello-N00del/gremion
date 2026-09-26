//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'agenda_section_reorder.g.dart';

/// AgendaSectionReorder
///
/// Properties:
/// * [position] 
@BuiltValue()
abstract class AgendaSectionReorder implements Built<AgendaSectionReorder, AgendaSectionReorderBuilder> {
  @BuiltValueField(wireName: r'position')
  int get position;

  AgendaSectionReorder._();

  factory AgendaSectionReorder([void updates(AgendaSectionReorderBuilder b)]) = _$AgendaSectionReorder;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AgendaSectionReorderBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AgendaSectionReorder> get serializer => _$AgendaSectionReorderSerializer();
}

class _$AgendaSectionReorderSerializer implements PrimitiveSerializer<AgendaSectionReorder> {
  @override
  final Iterable<Type> types = const [AgendaSectionReorder, _$AgendaSectionReorder];

  @override
  final String wireName = r'AgendaSectionReorder';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AgendaSectionReorder object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'position';
    yield serializers.serialize(
      object.position,
      specifiedType: const FullType(int),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    AgendaSectionReorder object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AgendaSectionReorderBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'position':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.position = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  AgendaSectionReorder deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AgendaSectionReorderBuilder();
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

