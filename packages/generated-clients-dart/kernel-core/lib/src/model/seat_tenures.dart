//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/tenure.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'seat_tenures.g.dart';

/// SeatTenures
///
/// Properties:
/// * [seatId] 
/// * [tenures] 
@BuiltValue()
abstract class SeatTenures implements Built<SeatTenures, SeatTenuresBuilder> {
  @BuiltValueField(wireName: r'seatId')
  String get seatId;

  @BuiltValueField(wireName: r'tenures')
  BuiltList<Tenure> get tenures;

  SeatTenures._();

  factory SeatTenures([void updates(SeatTenuresBuilder b)]) = _$SeatTenures;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(SeatTenuresBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<SeatTenures> get serializer => _$SeatTenuresSerializer();
}

class _$SeatTenuresSerializer implements PrimitiveSerializer<SeatTenures> {
  @override
  final Iterable<Type> types = const [SeatTenures, _$SeatTenures];

  @override
  final String wireName = r'SeatTenures';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    SeatTenures object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'seatId';
    yield serializers.serialize(
      object.seatId,
      specifiedType: const FullType(String),
    );
    yield r'tenures';
    yield serializers.serialize(
      object.tenures,
      specifiedType: const FullType(BuiltList, [FullType(Tenure)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    SeatTenures object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required SeatTenuresBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'seatId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.seatId = valueDes;
          break;
        case r'tenures':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(Tenure)]),
          ) as BuiltList<Tenure>;
          result.tenures.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  SeatTenures deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = SeatTenuresBuilder();
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

