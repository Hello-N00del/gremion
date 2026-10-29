//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'module_runtime_database.g.dart';

/// ModuleRuntimeDatabase
///
/// Properties:
/// * [postgresService] 
/// * [migrations] 
@BuiltValue()
abstract class ModuleRuntimeDatabase implements Built<ModuleRuntimeDatabase, ModuleRuntimeDatabaseBuilder> {
  @BuiltValueField(wireName: r'postgresService')
  String get postgresService;

  @BuiltValueField(wireName: r'migrations')
  String get migrations;

  ModuleRuntimeDatabase._();

  factory ModuleRuntimeDatabase([void updates(ModuleRuntimeDatabaseBuilder b)]) = _$ModuleRuntimeDatabase;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ModuleRuntimeDatabaseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ModuleRuntimeDatabase> get serializer => _$ModuleRuntimeDatabaseSerializer();
}

class _$ModuleRuntimeDatabaseSerializer implements PrimitiveSerializer<ModuleRuntimeDatabase> {
  @override
  final Iterable<Type> types = const [ModuleRuntimeDatabase, _$ModuleRuntimeDatabase];

  @override
  final String wireName = r'ModuleRuntimeDatabase';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ModuleRuntimeDatabase object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'postgresService';
    yield serializers.serialize(
      object.postgresService,
      specifiedType: const FullType(String),
    );
    yield r'migrations';
    yield serializers.serialize(
      object.migrations,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ModuleRuntimeDatabase object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ModuleRuntimeDatabaseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'postgresService':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.postgresService = valueDes;
          break;
        case r'migrations':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.migrations = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ModuleRuntimeDatabase deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ModuleRuntimeDatabaseBuilder();
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

