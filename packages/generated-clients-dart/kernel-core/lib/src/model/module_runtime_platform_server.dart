//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'module_runtime_platform_server.g.dart';

/// ModuleRuntimePlatformServer
///
/// Properties:
/// * [postgresService] 
/// * [databases] 
@BuiltValue()
abstract class ModuleRuntimePlatformServer implements Built<ModuleRuntimePlatformServer, ModuleRuntimePlatformServerBuilder> {
  @BuiltValueField(wireName: r'postgresService')
  String get postgresService;

  @BuiltValueField(wireName: r'databases')
  BuiltList<String> get databases;

  ModuleRuntimePlatformServer._();

  factory ModuleRuntimePlatformServer([void updates(ModuleRuntimePlatformServerBuilder b)]) = _$ModuleRuntimePlatformServer;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ModuleRuntimePlatformServerBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ModuleRuntimePlatformServer> get serializer => _$ModuleRuntimePlatformServerSerializer();
}

class _$ModuleRuntimePlatformServerSerializer implements PrimitiveSerializer<ModuleRuntimePlatformServer> {
  @override
  final Iterable<Type> types = const [ModuleRuntimePlatformServer, _$ModuleRuntimePlatformServer];

  @override
  final String wireName = r'ModuleRuntimePlatformServer';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ModuleRuntimePlatformServer object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'postgresService';
    yield serializers.serialize(
      object.postgresService,
      specifiedType: const FullType(String),
    );
    yield r'databases';
    yield serializers.serialize(
      object.databases,
      specifiedType: const FullType(BuiltList, [FullType(String)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ModuleRuntimePlatformServer object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ModuleRuntimePlatformServerBuilder result,
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
        case r'databases':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(String)]),
          ) as BuiltList<String>;
          result.databases.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ModuleRuntimePlatformServer deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ModuleRuntimePlatformServerBuilder();
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

