//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'notice_override_create.g.dart';

/// NoticeOverrideCreate
///
/// Properties:
/// * [reason] - Required (DOMAIN [D R20-D26-5]).
/// * [curingBasisId] 
@BuiltValue()
abstract class NoticeOverrideCreate implements Built<NoticeOverrideCreate, NoticeOverrideCreateBuilder> {
  /// Required (DOMAIN [D R20-D26-5]).
  @BuiltValueField(wireName: r'reason')
  String get reason;

  @BuiltValueField(wireName: r'curing_basis_id')
  String? get curingBasisId;

  NoticeOverrideCreate._();

  factory NoticeOverrideCreate([void updates(NoticeOverrideCreateBuilder b)]) = _$NoticeOverrideCreate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(NoticeOverrideCreateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<NoticeOverrideCreate> get serializer => _$NoticeOverrideCreateSerializer();
}

class _$NoticeOverrideCreateSerializer implements PrimitiveSerializer<NoticeOverrideCreate> {
  @override
  final Iterable<Type> types = const [NoticeOverrideCreate, _$NoticeOverrideCreate];

  @override
  final String wireName = r'NoticeOverrideCreate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    NoticeOverrideCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'reason';
    yield serializers.serialize(
      object.reason,
      specifiedType: const FullType(String),
    );
    if (object.curingBasisId != null) {
      yield r'curing_basis_id';
      yield serializers.serialize(
        object.curingBasisId,
        specifiedType: const FullType(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    NoticeOverrideCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required NoticeOverrideCreateBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'reason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.reason = valueDes;
          break;
        case r'curing_basis_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.curingBasisId = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  NoticeOverrideCreate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = NoticeOverrideCreateBuilder();
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

