//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'create_body.g.dart';

/// CreateBody
///
/// Properties:
/// * [kindKey] 
/// * [name] 
/// * [shortName] 
/// * [parentBodyId] 
@BuiltValue()
abstract class CreateBody implements Built<CreateBody, CreateBodyBuilder> {
  @BuiltValueField(wireName: r'kindKey')
  String get kindKey;

  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'shortName')
  String? get shortName;

  @BuiltValueField(wireName: r'parentBodyId')
  String? get parentBodyId;

  CreateBody._();

  factory CreateBody([void updates(CreateBodyBuilder b)]) = _$CreateBody;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(CreateBodyBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<CreateBody> get serializer => _$CreateBodySerializer();
}

class _$CreateBodySerializer implements PrimitiveSerializer<CreateBody> {
  @override
  final Iterable<Type> types = const [CreateBody, _$CreateBody];

  @override
  final String wireName = r'CreateBody';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    CreateBody object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'kindKey';
    yield serializers.serialize(
      object.kindKey,
      specifiedType: const FullType(String),
    );
    yield r'name';
    yield serializers.serialize(
      object.name,
      specifiedType: const FullType(String),
    );
    if (object.shortName != null) {
      yield r'shortName';
      yield serializers.serialize(
        object.shortName,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.parentBodyId != null) {
      yield r'parentBodyId';
      yield serializers.serialize(
        object.parentBodyId,
        specifiedType: const FullType.nullable(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    CreateBody object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required CreateBodyBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'kindKey':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.kindKey = valueDes;
          break;
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        case r'shortName':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.shortName = valueDes;
          break;
        case r'parentBodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.parentBodyId = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  CreateBody deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = CreateBodyBuilder();
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

