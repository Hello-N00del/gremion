//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_core_client/src/model/module_runtime_platform_server.dart';
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime_database.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime_timed_jobs_inner.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime_export.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'module_runtime.g.dart';

/// The runtime block of modules/<key>/module.json (spec D D.1.2), served only for the version the customer enabled.
///
/// Properties:
/// * [version] 
/// * [database] 
/// * [export_] 
/// * [timedJobs] 
/// * [platformServer] 
@BuiltValue()
abstract class ModuleRuntime implements Built<ModuleRuntime, ModuleRuntimeBuilder> {
  @BuiltValueField(wireName: r'version')
  String get version;

  @BuiltValueField(wireName: r'database')
  ModuleRuntimeDatabase? get database;

  @BuiltValueField(wireName: r'export')
  ModuleRuntimeExport? get export_;

  @BuiltValueField(wireName: r'timedJobs')
  BuiltList<ModuleRuntimeTimedJobsInner> get timedJobs;

  @BuiltValueField(wireName: r'platformServer')
  ModuleRuntimePlatformServer? get platformServer;

  ModuleRuntime._();

  factory ModuleRuntime([void updates(ModuleRuntimeBuilder b)]) = _$ModuleRuntime;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ModuleRuntimeBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ModuleRuntime> get serializer => _$ModuleRuntimeSerializer();
}

class _$ModuleRuntimeSerializer implements PrimitiveSerializer<ModuleRuntime> {
  @override
  final Iterable<Type> types = const [ModuleRuntime, _$ModuleRuntime];

  @override
  final String wireName = r'ModuleRuntime';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ModuleRuntime object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'version';
    yield serializers.serialize(
      object.version,
      specifiedType: const FullType(String),
    );
    yield r'database';
    yield object.database == null ? null : serializers.serialize(
      object.database,
      specifiedType: const FullType.nullable(ModuleRuntimeDatabase),
    );
    yield r'export';
    yield object.export_ == null ? null : serializers.serialize(
      object.export_,
      specifiedType: const FullType.nullable(ModuleRuntimeExport),
    );
    yield r'timedJobs';
    yield serializers.serialize(
      object.timedJobs,
      specifiedType: const FullType(BuiltList, [FullType(ModuleRuntimeTimedJobsInner)]),
    );
    yield r'platformServer';
    yield object.platformServer == null ? null : serializers.serialize(
      object.platformServer,
      specifiedType: const FullType.nullable(ModuleRuntimePlatformServer),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ModuleRuntime object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ModuleRuntimeBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'version':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.version = valueDes;
          break;
        case r'database':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(ModuleRuntimeDatabase),
          ) as ModuleRuntimeDatabase?;
          if (valueDes == null) continue;
          result.database.replace(valueDes);
          break;
        case r'export':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(ModuleRuntimeExport),
          ) as ModuleRuntimeExport?;
          if (valueDes == null) continue;
          result.export_.replace(valueDes);
          break;
        case r'timedJobs':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(ModuleRuntimeTimedJobsInner)]),
          ) as BuiltList<ModuleRuntimeTimedJobsInner>;
          result.timedJobs.replace(valueDes);
          break;
        case r'platformServer':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(ModuleRuntimePlatformServer),
          ) as ModuleRuntimePlatformServer?;
          if (valueDes == null) continue;
          result.platformServer.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ModuleRuntime deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ModuleRuntimeBuilder();
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

