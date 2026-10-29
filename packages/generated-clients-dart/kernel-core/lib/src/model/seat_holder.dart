//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_core_client/src/model/date.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'seat_holder.g.dart';

/// SeatHolder
///
/// Properties:
/// * [tenureId] 
/// * [personId] 
/// * [startsOn] 
/// * [plannedEndOn] 
@BuiltValue()
abstract class SeatHolder implements Built<SeatHolder, SeatHolderBuilder> {
  @BuiltValueField(wireName: r'tenureId')
  String get tenureId;

  @BuiltValueField(wireName: r'personId')
  String get personId;

  @BuiltValueField(wireName: r'startsOn')
  Date get startsOn;

  @BuiltValueField(wireName: r'plannedEndOn')
  Date? get plannedEndOn;

  SeatHolder._();

  factory SeatHolder([void updates(SeatHolderBuilder b)]) = _$SeatHolder;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(SeatHolderBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<SeatHolder> get serializer => _$SeatHolderSerializer();
}

class _$SeatHolderSerializer implements PrimitiveSerializer<SeatHolder> {
  @override
  final Iterable<Type> types = const [SeatHolder, _$SeatHolder];

  @override
  final String wireName = r'SeatHolder';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    SeatHolder object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'tenureId';
    yield serializers.serialize(
      object.tenureId,
      specifiedType: const FullType(String),
    );
    yield r'personId';
    yield serializers.serialize(
      object.personId,
      specifiedType: const FullType(String),
    );
    yield r'startsOn';
    yield serializers.serialize(
      object.startsOn,
      specifiedType: const FullType(Date),
    );
    yield r'plannedEndOn';
    yield object.plannedEndOn == null ? null : serializers.serialize(
      object.plannedEndOn,
      specifiedType: const FullType.nullable(Date),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    SeatHolder object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required SeatHolderBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'tenureId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.tenureId = valueDes;
          break;
        case r'personId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.personId = valueDes;
          break;
        case r'startsOn':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(Date),
          ) as Date;
          result.startsOn = valueDes;
          break;
        case r'plannedEndOn':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.plannedEndOn = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  SeatHolder deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = SeatHolderBuilder();
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

