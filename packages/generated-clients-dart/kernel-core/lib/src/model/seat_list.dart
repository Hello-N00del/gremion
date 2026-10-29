//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/seat.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'seat_list.g.dart';

/// SeatList
///
/// Properties:
/// * [bodyId] 
/// * [seats] 
@BuiltValue()
abstract class SeatList implements Built<SeatList, SeatListBuilder> {
  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'seats')
  BuiltList<Seat> get seats;

  SeatList._();

  factory SeatList([void updates(SeatListBuilder b)]) = _$SeatList;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(SeatListBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<SeatList> get serializer => _$SeatListSerializer();
}

class _$SeatListSerializer implements PrimitiveSerializer<SeatList> {
  @override
  final Iterable<Type> types = const [SeatList, _$SeatList];

  @override
  final String wireName = r'SeatList';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    SeatList object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'seats';
    yield serializers.serialize(
      object.seats,
      specifiedType: const FullType(BuiltList, [FullType(Seat)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    SeatList object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required SeatListBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'bodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'seats':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(Seat)]),
          ) as BuiltList<Seat>;
          result.seats.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  SeatList deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = SeatListBuilder();
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

