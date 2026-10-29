//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'module_runtime_export.g.dart';

/// ModuleRuntimeExport
///
/// Properties:
/// * [kind] 
/// * [retentionProfile] 
@BuiltValue()
abstract class ModuleRuntimeExport implements Built<ModuleRuntimeExport, ModuleRuntimeExportBuilder> {
  @BuiltValueField(wireName: r'kind')
  String get kind;

  @BuiltValueField(wireName: r'retentionProfile')
  String get retentionProfile;

  ModuleRuntimeExport._();

  factory ModuleRuntimeExport([void updates(ModuleRuntimeExportBuilder b)]) = _$ModuleRuntimeExport;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ModuleRuntimeExportBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ModuleRuntimeExport> get serializer => _$ModuleRuntimeExportSerializer();
}

class _$ModuleRuntimeExportSerializer implements PrimitiveSerializer<ModuleRuntimeExport> {
  @override
  final Iterable<Type> types = const [ModuleRuntimeExport, _$ModuleRuntimeExport];

  @override
  final String wireName = r'ModuleRuntimeExport';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ModuleRuntimeExport object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'kind';
    yield serializers.serialize(
      object.kind,
      specifiedType: const FullType(String),
    );
    yield r'retentionProfile';
    yield serializers.serialize(
      object.retentionProfile,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ModuleRuntimeExport object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ModuleRuntimeExportBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'kind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.kind = valueDes;
          break;
        case r'retentionProfile':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.retentionProfile = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ModuleRuntimeExport deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ModuleRuntimeExportBuilder();
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

