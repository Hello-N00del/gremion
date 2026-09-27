//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'motion_create.g.dart';

/// MotionCreate
///
/// Properties:
/// * [title] 
/// * [motionText] 
/// * [rationale] 
/// * [agendaItemId] 
@BuiltValue()
abstract class MotionCreate implements Built<MotionCreate, MotionCreateBuilder> {
  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'motion_text')
  String get motionText;

  @BuiltValueField(wireName: r'rationale')
  String? get rationale;

  @BuiltValueField(wireName: r'agenda_item_id')
  String? get agendaItemId;

  MotionCreate._();

  factory MotionCreate([void updates(MotionCreateBuilder b)]) = _$MotionCreate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MotionCreateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MotionCreate> get serializer => _$MotionCreateSerializer();
}

class _$MotionCreateSerializer implements PrimitiveSerializer<MotionCreate> {
  @override
  final Iterable<Type> types = const [MotionCreate, _$MotionCreate];

  @override
  final String wireName = r'MotionCreate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MotionCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
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
        specifiedType: const FullType(String),
      );
    }
    if (object.agendaItemId != null) {
      yield r'agenda_item_id';
      yield serializers.serialize(
        object.agendaItemId,
        specifiedType: const FullType(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    MotionCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MotionCreateBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
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
            specifiedType: const FullType(String),
          ) as String;
          result.rationale = valueDes;
          break;
        case r'agenda_item_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.agendaItemId = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  MotionCreate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MotionCreateBuilder();
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

