//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_core_client/src/model/module_runtime.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'enabled_module.g.dart';

/// EnabledModule
///
/// Properties:
/// * [moduleKey] 
/// * [semver] 
/// * [runtime] 
@BuiltValue()
abstract class EnabledModule implements Built<EnabledModule, EnabledModuleBuilder> {
  @BuiltValueField(wireName: r'moduleKey')
  String get moduleKey;

  @BuiltValueField(wireName: r'semver')
  String get semver;

  @BuiltValueField(wireName: r'runtime')
  ModuleRuntime get runtime;

  EnabledModule._();

  factory EnabledModule([void updates(EnabledModuleBuilder b)]) = _$EnabledModule;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(EnabledModuleBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<EnabledModule> get serializer => _$EnabledModuleSerializer();
}

class _$EnabledModuleSerializer implements PrimitiveSerializer<EnabledModule> {
  @override
  final Iterable<Type> types = const [EnabledModule, _$EnabledModule];

  @override
  final String wireName = r'EnabledModule';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    EnabledModule object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'moduleKey';
    yield serializers.serialize(
      object.moduleKey,
      specifiedType: const FullType(String),
    );
    yield r'semver';
    yield serializers.serialize(
      object.semver,
      specifiedType: const FullType(String),
    );
    yield r'runtime';
    yield serializers.serialize(
      object.runtime,
      specifiedType: const FullType(ModuleRuntime),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    EnabledModule object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required EnabledModuleBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'moduleKey':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.moduleKey = valueDes;
          break;
        case r'semver':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.semver = valueDes;
          break;
        case r'runtime':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ModuleRuntime),
          ) as ModuleRuntime;
          result.runtime.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  EnabledModule deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = EnabledModuleBuilder();
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

