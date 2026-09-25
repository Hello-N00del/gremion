//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'subsystem_result.g.dart';

/// SubsystemResult
///
/// Properties:
/// * [subsystem] 
/// * [status] 
/// * [error] 
/// * [willRetry] 
@BuiltValue()
abstract class SubsystemResult implements Built<SubsystemResult, SubsystemResultBuilder> {
  @BuiltValueField(wireName: r'subsystem')
  SubsystemResultSubsystemEnum get subsystem;
  // enum subsystemEnum {  keycloak,  matrix,  nextcloud,  };

  @BuiltValueField(wireName: r'status')
  SubsystemResultStatusEnum get status;
  // enum statusEnum {  ok,  failed,  skipped,  };

  @BuiltValueField(wireName: r'error')
  String? get error;

  @BuiltValueField(wireName: r'willRetry')
  bool get willRetry;

  SubsystemResult._();

  factory SubsystemResult([void updates(SubsystemResultBuilder b)]) = _$SubsystemResult;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(SubsystemResultBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<SubsystemResult> get serializer => _$SubsystemResultSerializer();
}

class _$SubsystemResultSerializer implements PrimitiveSerializer<SubsystemResult> {
  @override
  final Iterable<Type> types = const [SubsystemResult, _$SubsystemResult];

  @override
  final String wireName = r'SubsystemResult';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    SubsystemResult object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'subsystem';
    yield serializers.serialize(
      object.subsystem,
      specifiedType: const FullType(SubsystemResultSubsystemEnum),
    );
    yield r'status';
    yield serializers.serialize(
      object.status,
      specifiedType: const FullType(SubsystemResultStatusEnum),
    );
    if (object.error != null) {
      yield r'error';
      yield serializers.serialize(
        object.error,
        specifiedType: const FullType(String),
      );
    }
    yield r'willRetry';
    yield serializers.serialize(
      object.willRetry,
      specifiedType: const FullType(bool),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    SubsystemResult object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required SubsystemResultBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'subsystem':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(SubsystemResultSubsystemEnum),
          ) as SubsystemResultSubsystemEnum;
          result.subsystem = valueDes;
          break;
        case r'status':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(SubsystemResultStatusEnum),
          ) as SubsystemResultStatusEnum;
          result.status = valueDes;
          break;
        case r'error':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.error = valueDes;
          break;
        case r'willRetry':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.willRetry = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  SubsystemResult deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = SubsystemResultBuilder();
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

class SubsystemResultSubsystemEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'keycloak')
  static const SubsystemResultSubsystemEnum keycloak = _$subsystemResultSubsystemEnum_keycloak;
  @BuiltValueEnumConst(wireName: r'matrix')
  static const SubsystemResultSubsystemEnum matrix = _$subsystemResultSubsystemEnum_matrix;
  @BuiltValueEnumConst(wireName: r'nextcloud')
  static const SubsystemResultSubsystemEnum nextcloud = _$subsystemResultSubsystemEnum_nextcloud;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const SubsystemResultSubsystemEnum unknownDefaultOpenApi = _$subsystemResultSubsystemEnum_unknownDefaultOpenApi;

  static Serializer<SubsystemResultSubsystemEnum> get serializer => _$subsystemResultSubsystemEnumSerializer;

  const SubsystemResultSubsystemEnum._(String name): super(name);

  static BuiltSet<SubsystemResultSubsystemEnum> get values => _$subsystemResultSubsystemEnumValues;
  static SubsystemResultSubsystemEnum valueOf(String name) => _$subsystemResultSubsystemEnumValueOf(name);
}

class SubsystemResultStatusEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'ok')
  static const SubsystemResultStatusEnum ok = _$subsystemResultStatusEnum_ok;
  @BuiltValueEnumConst(wireName: r'failed')
  static const SubsystemResultStatusEnum failed = _$subsystemResultStatusEnum_failed;
  @BuiltValueEnumConst(wireName: r'skipped')
  static const SubsystemResultStatusEnum skipped = _$subsystemResultStatusEnum_skipped;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const SubsystemResultStatusEnum unknownDefaultOpenApi = _$subsystemResultStatusEnum_unknownDefaultOpenApi;

  static Serializer<SubsystemResultStatusEnum> get serializer => _$subsystemResultStatusEnumSerializer;

  const SubsystemResultStatusEnum._(String name): super(name);

  static BuiltSet<SubsystemResultStatusEnum> get values => _$subsystemResultStatusEnumValues;
  static SubsystemResultStatusEnum valueOf(String name) => _$subsystemResultStatusEnumValueOf(name);
}

