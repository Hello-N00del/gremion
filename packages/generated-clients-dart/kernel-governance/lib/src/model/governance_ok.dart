//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'governance_ok.g.dart';

/// GovernanceOk
///
/// Properties:
/// * [success] 
@BuiltValue()
abstract class GovernanceOk implements Built<GovernanceOk, GovernanceOkBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  GovernanceOk._();

  factory GovernanceOk([void updates(GovernanceOkBuilder b)]) = _$GovernanceOk;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(GovernanceOkBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<GovernanceOk> get serializer => _$GovernanceOkSerializer();
}

class _$GovernanceOkSerializer implements PrimitiveSerializer<GovernanceOk> {
  @override
  final Iterable<Type> types = const [GovernanceOk, _$GovernanceOk];

  @override
  final String wireName = r'GovernanceOk';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    GovernanceOk object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'success';
    yield serializers.serialize(
      object.success,
      specifiedType: const FullType(bool),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    GovernanceOk object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required GovernanceOkBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'success':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.success = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  GovernanceOk deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = GovernanceOkBuilder();
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

