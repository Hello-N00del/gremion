//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'body.g.dart';

/// DB-IDT-BODY: a Gremium, the authorisation scope.
///
/// Properties:
/// * [bodyId] 
/// * [kindKey] 
/// * [name] 
/// * [shortName] 
/// * [parentBodyId] 
/// * [state] 
/// * [archivedAt] 
/// * [rowVersion] 
@BuiltValue()
abstract class Body implements Built<Body, BodyBuilder> {
  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'kindKey')
  String get kindKey;

  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'shortName')
  String? get shortName;

  @BuiltValueField(wireName: r'parentBodyId')
  String? get parentBodyId;

  @BuiltValueField(wireName: r'state')
  BodyStateEnum get state;
  // enum stateEnum {  active,  archived,  };

  @BuiltValueField(wireName: r'archivedAt')
  DateTime? get archivedAt;

  @BuiltValueField(wireName: r'rowVersion')
  int get rowVersion;

  Body._();

  factory Body([void updates(BodyBuilder b)]) = _$Body;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(BodyBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Body> get serializer => _$BodySerializer();
}

class _$BodySerializer implements PrimitiveSerializer<Body> {
  @override
  final Iterable<Type> types = const [Body, _$Body];

  @override
  final String wireName = r'Body';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Body object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
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
    yield r'shortName';
    yield object.shortName == null ? null : serializers.serialize(
      object.shortName,
      specifiedType: const FullType.nullable(String),
    );
    yield r'parentBodyId';
    yield object.parentBodyId == null ? null : serializers.serialize(
      object.parentBodyId,
      specifiedType: const FullType.nullable(String),
    );
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(BodyStateEnum),
    );
    yield r'archivedAt';
    yield object.archivedAt == null ? null : serializers.serialize(
      object.archivedAt,
      specifiedType: const FullType.nullable(DateTime),
    );
    yield r'rowVersion';
    yield serializers.serialize(
      object.rowVersion,
      specifiedType: const FullType(int),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Body object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required BodyBuilder result,
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
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BodyStateEnum),
          ) as BodyStateEnum;
          result.state = valueDes;
          break;
        case r'archivedAt':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.archivedAt = valueDes;
          break;
        case r'rowVersion':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.rowVersion = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Body deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = BodyBuilder();
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

class BodyStateEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'active')
  static const BodyStateEnum active = _$bodyStateEnum_active;
  @BuiltValueEnumConst(wireName: r'archived')
  static const BodyStateEnum archived = _$bodyStateEnum_archived;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const BodyStateEnum unknownDefaultOpenApi = _$bodyStateEnum_unknownDefaultOpenApi;

  static Serializer<BodyStateEnum> get serializer => _$bodyStateEnumSerializer;

  const BodyStateEnum._(String name): super(name);

  static BuiltSet<BodyStateEnum> get values => _$bodyStateEnumValues;
  static BodyStateEnum valueOf(String name) => _$bodyStateEnumValueOf(name);
}

