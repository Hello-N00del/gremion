//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'module_runtime_timed_jobs_inner.g.dart';

/// ModuleRuntimeTimedJobsInner
///
/// Properties:
/// * [id] 
/// * [activeColourOnly] 
@BuiltValue()
abstract class ModuleRuntimeTimedJobsInner implements Built<ModuleRuntimeTimedJobsInner, ModuleRuntimeTimedJobsInnerBuilder> {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'activeColourOnly')
  bool get activeColourOnly;

  ModuleRuntimeTimedJobsInner._();

  factory ModuleRuntimeTimedJobsInner([void updates(ModuleRuntimeTimedJobsInnerBuilder b)]) = _$ModuleRuntimeTimedJobsInner;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ModuleRuntimeTimedJobsInnerBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ModuleRuntimeTimedJobsInner> get serializer => _$ModuleRuntimeTimedJobsInnerSerializer();
}

class _$ModuleRuntimeTimedJobsInnerSerializer implements PrimitiveSerializer<ModuleRuntimeTimedJobsInner> {
  @override
  final Iterable<Type> types = const [ModuleRuntimeTimedJobsInner, _$ModuleRuntimeTimedJobsInner];

  @override
  final String wireName = r'ModuleRuntimeTimedJobsInner';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ModuleRuntimeTimedJobsInner object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'id';
    yield serializers.serialize(
      object.id,
      specifiedType: const FullType(String),
    );
    yield r'activeColourOnly';
    yield serializers.serialize(
      object.activeColourOnly,
      specifiedType: const FullType(bool),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ModuleRuntimeTimedJobsInner object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ModuleRuntimeTimedJobsInnerBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.id = valueDes;
          break;
        case r'activeColourOnly':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.activeColourOnly = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ModuleRuntimeTimedJobsInner deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ModuleRuntimeTimedJobsInnerBuilder();
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

