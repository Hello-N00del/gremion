//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/enabled_module.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'enabled_modules.g.dart';

/// EnabledModules
///
/// Properties:
/// * [customerId] - DB-TNT-CUSTOMER id: a canonical lower-case UUIDv7.
/// * [modules] 
@BuiltValue()
abstract class EnabledModules implements Built<EnabledModules, EnabledModulesBuilder> {
  /// DB-TNT-CUSTOMER id: a canonical lower-case UUIDv7.
  @BuiltValueField(wireName: r'customerId')
  String get customerId;

  @BuiltValueField(wireName: r'modules')
  BuiltList<EnabledModule> get modules;

  EnabledModules._();

  factory EnabledModules([void updates(EnabledModulesBuilder b)]) = _$EnabledModules;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(EnabledModulesBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<EnabledModules> get serializer => _$EnabledModulesSerializer();
}

class _$EnabledModulesSerializer implements PrimitiveSerializer<EnabledModules> {
  @override
  final Iterable<Type> types = const [EnabledModules, _$EnabledModules];

  @override
  final String wireName = r'EnabledModules';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    EnabledModules object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'customerId';
    yield serializers.serialize(
      object.customerId,
      specifiedType: const FullType(String),
    );
    yield r'modules';
    yield serializers.serialize(
      object.modules,
      specifiedType: const FullType(BuiltList, [FullType(EnabledModule)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    EnabledModules object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required EnabledModulesBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'customerId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.customerId = valueDes;
          break;
        case r'modules':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(EnabledModule)]),
          ) as BuiltList<EnabledModule>;
          result.modules.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  EnabledModules deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = EnabledModulesBuilder();
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

