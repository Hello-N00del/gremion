//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/date.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'tenure.g.dart';

/// DB-IDT-TENURE: one holding of a seat; the seat history is the list of these.
///
/// Properties:
/// * [tenureId] 
/// * [personId] 
/// * [wahlperiodeId] 
/// * [startsOn] 
/// * [plannedEndOn] 
/// * [endedOn] 
/// * [endReason] 
/// * [source_] 
@BuiltValue()
abstract class Tenure implements Built<Tenure, TenureBuilder> {
  @BuiltValueField(wireName: r'tenureId')
  String get tenureId;

  @BuiltValueField(wireName: r'personId')
  String get personId;

  @BuiltValueField(wireName: r'wahlperiodeId')
  String? get wahlperiodeId;

  @BuiltValueField(wireName: r'startsOn')
  Date get startsOn;

  @BuiltValueField(wireName: r'plannedEndOn')
  Date? get plannedEndOn;

  @BuiltValueField(wireName: r'endedOn')
  Date? get endedOn;

  @BuiltValueField(wireName: r'endReason')
  TenureEndReasonEnum? get endReason;
  // enum endReasonEnum {  term_end,  resigned,  removed,  succeeded,  data_correction,  };

  @BuiltValueField(wireName: r'source')
  TenureSource_Enum get source_;
  // enum source_Enum {  election,  delegation,  appointment,  succession,  };

  Tenure._();

  factory Tenure([void updates(TenureBuilder b)]) = _$Tenure;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(TenureBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Tenure> get serializer => _$TenureSerializer();
}

class _$TenureSerializer implements PrimitiveSerializer<Tenure> {
  @override
  final Iterable<Type> types = const [Tenure, _$Tenure];

  @override
  final String wireName = r'Tenure';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Tenure object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'tenureId';
    yield serializers.serialize(
      object.tenureId,
      specifiedType: const FullType(String),
    );
    yield r'personId';
    yield serializers.serialize(
      object.personId,
      specifiedType: const FullType(String),
    );
    yield r'wahlperiodeId';
    yield object.wahlperiodeId == null ? null : serializers.serialize(
      object.wahlperiodeId,
      specifiedType: const FullType.nullable(String),
    );
    yield r'startsOn';
    yield serializers.serialize(
      object.startsOn,
      specifiedType: const FullType(Date),
    );
    yield r'plannedEndOn';
    yield object.plannedEndOn == null ? null : serializers.serialize(
      object.plannedEndOn,
      specifiedType: const FullType.nullable(Date),
    );
    yield r'endedOn';
    yield object.endedOn == null ? null : serializers.serialize(
      object.endedOn,
      specifiedType: const FullType.nullable(Date),
    );
    yield r'endReason';
    yield object.endReason == null ? null : serializers.serialize(
      object.endReason,
      specifiedType: const FullType.nullable(TenureEndReasonEnum),
    );
    yield r'source';
    yield serializers.serialize(
      object.source_,
      specifiedType: const FullType(TenureSource_Enum),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Tenure object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required TenureBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'tenureId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.tenureId = valueDes;
          break;
        case r'personId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.personId = valueDes;
          break;
        case r'wahlperiodeId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.wahlperiodeId = valueDes;
          break;
        case r'startsOn':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(Date),
          ) as Date;
          result.startsOn = valueDes;
          break;
        case r'plannedEndOn':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.plannedEndOn = valueDes;
          break;
        case r'endedOn':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.endedOn = valueDes;
          break;
        case r'endReason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(TenureEndReasonEnum),
          ) as TenureEndReasonEnum?;
          if (valueDes == null) continue;
          result.endReason = valueDes;
          break;
        case r'source':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(TenureSource_Enum),
          ) as TenureSource_Enum;
          result.source_ = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Tenure deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = TenureBuilder();
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

class TenureEndReasonEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'term_end')
  static const TenureEndReasonEnum termEnd = _$tenureEndReasonEnum_termEnd;
  @BuiltValueEnumConst(wireName: r'resigned')
  static const TenureEndReasonEnum resigned = _$tenureEndReasonEnum_resigned;
  @BuiltValueEnumConst(wireName: r'removed')
  static const TenureEndReasonEnum removed = _$tenureEndReasonEnum_removed;
  @BuiltValueEnumConst(wireName: r'succeeded')
  static const TenureEndReasonEnum succeeded = _$tenureEndReasonEnum_succeeded;
  @BuiltValueEnumConst(wireName: r'data_correction')
  static const TenureEndReasonEnum dataCorrection = _$tenureEndReasonEnum_dataCorrection;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const TenureEndReasonEnum unknownDefaultOpenApi = _$tenureEndReasonEnum_unknownDefaultOpenApi;

  static Serializer<TenureEndReasonEnum> get serializer => _$tenureEndReasonEnumSerializer;

  const TenureEndReasonEnum._(String name): super(name);

  static BuiltSet<TenureEndReasonEnum> get values => _$tenureEndReasonEnumValues;
  static TenureEndReasonEnum valueOf(String name) => _$tenureEndReasonEnumValueOf(name);
}

class TenureSource_Enum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'election')
  static const TenureSource_Enum election = _$tenureSourceEnum_election;
  @BuiltValueEnumConst(wireName: r'delegation')
  static const TenureSource_Enum delegation = _$tenureSourceEnum_delegation;
  @BuiltValueEnumConst(wireName: r'appointment')
  static const TenureSource_Enum appointment = _$tenureSourceEnum_appointment;
  @BuiltValueEnumConst(wireName: r'succession')
  static const TenureSource_Enum succession = _$tenureSourceEnum_succession;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const TenureSource_Enum unknownDefaultOpenApi = _$tenureSourceEnum_unknownDefaultOpenApi;

  static Serializer<TenureSource_Enum> get serializer => _$tenureSourceEnumSerializer;

  const TenureSource_Enum._(String name): super(name);

  static BuiltSet<TenureSource_Enum> get values => _$tenureSourceEnumValues;
  static TenureSource_Enum valueOf(String name) => _$tenureSourceEnumValueOf(name);
}

