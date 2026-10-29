//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/seat_holder.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'seat.g.dart';

/// DB-IDT-SEAT with its holders today (open tenures that have started).
///
/// Properties:
/// * [seatId] 
/// * [bodyId] 
/// * [orgUnitId] 
/// * [title] 
/// * [seatKind] 
/// * [fillMode] 
/// * [holderCardinality] 
/// * [voting] 
/// * [state] 
/// * [holders] 
@BuiltValue()
abstract class Seat implements Built<Seat, SeatBuilder> {
  @BuiltValueField(wireName: r'seatId')
  String get seatId;

  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'orgUnitId')
  String? get orgUnitId;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'seatKind')
  SeatSeatKindEnum get seatKind;
  // enum seatKindEnum {  voting_member,  office,  advisory,  };

  @BuiltValueField(wireName: r'fillMode')
  SeatFillModeEnum get fillMode;
  // enum fillModeEnum {  direct_election,  delegation,  appointment,  };

  @BuiltValueField(wireName: r'holderCardinality')
  SeatHolderCardinalityEnum get holderCardinality;
  // enum holderCardinalityEnum {  single,  multiple,  };

  @BuiltValueField(wireName: r'voting')
  bool get voting;

  @BuiltValueField(wireName: r'state')
  SeatStateEnum get state;
  // enum stateEnum {  active,  retired,  };

  @BuiltValueField(wireName: r'holders')
  BuiltList<SeatHolder> get holders;

  Seat._();

  factory Seat([void updates(SeatBuilder b)]) = _$Seat;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(SeatBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Seat> get serializer => _$SeatSerializer();
}

class _$SeatSerializer implements PrimitiveSerializer<Seat> {
  @override
  final Iterable<Type> types = const [Seat, _$Seat];

  @override
  final String wireName = r'Seat';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Seat object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'seatId';
    yield serializers.serialize(
      object.seatId,
      specifiedType: const FullType(String),
    );
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'orgUnitId';
    yield object.orgUnitId == null ? null : serializers.serialize(
      object.orgUnitId,
      specifiedType: const FullType.nullable(String),
    );
    yield r'title';
    yield serializers.serialize(
      object.title,
      specifiedType: const FullType(String),
    );
    yield r'seatKind';
    yield serializers.serialize(
      object.seatKind,
      specifiedType: const FullType(SeatSeatKindEnum),
    );
    yield r'fillMode';
    yield serializers.serialize(
      object.fillMode,
      specifiedType: const FullType(SeatFillModeEnum),
    );
    yield r'holderCardinality';
    yield serializers.serialize(
      object.holderCardinality,
      specifiedType: const FullType(SeatHolderCardinalityEnum),
    );
    yield r'voting';
    yield serializers.serialize(
      object.voting,
      specifiedType: const FullType(bool),
    );
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(SeatStateEnum),
    );
    yield r'holders';
    yield serializers.serialize(
      object.holders,
      specifiedType: const FullType(BuiltList, [FullType(SeatHolder)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Seat object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required SeatBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'seatId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.seatId = valueDes;
          break;
        case r'bodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'orgUnitId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.orgUnitId = valueDes;
          break;
        case r'title':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.title = valueDes;
          break;
        case r'seatKind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(SeatSeatKindEnum),
          ) as SeatSeatKindEnum;
          result.seatKind = valueDes;
          break;
        case r'fillMode':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(SeatFillModeEnum),
          ) as SeatFillModeEnum;
          result.fillMode = valueDes;
          break;
        case r'holderCardinality':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(SeatHolderCardinalityEnum),
          ) as SeatHolderCardinalityEnum;
          result.holderCardinality = valueDes;
          break;
        case r'voting':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.voting = valueDes;
          break;
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(SeatStateEnum),
          ) as SeatStateEnum;
          result.state = valueDes;
          break;
        case r'holders':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(SeatHolder)]),
          ) as BuiltList<SeatHolder>;
          result.holders.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Seat deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = SeatBuilder();
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

class SeatSeatKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'voting_member')
  static const SeatSeatKindEnum votingMember = _$seatSeatKindEnum_votingMember;
  @BuiltValueEnumConst(wireName: r'office')
  static const SeatSeatKindEnum office = _$seatSeatKindEnum_office;
  @BuiltValueEnumConst(wireName: r'advisory')
  static const SeatSeatKindEnum advisory = _$seatSeatKindEnum_advisory;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const SeatSeatKindEnum unknownDefaultOpenApi = _$seatSeatKindEnum_unknownDefaultOpenApi;

  static Serializer<SeatSeatKindEnum> get serializer => _$seatSeatKindEnumSerializer;

  const SeatSeatKindEnum._(String name): super(name);

  static BuiltSet<SeatSeatKindEnum> get values => _$seatSeatKindEnumValues;
  static SeatSeatKindEnum valueOf(String name) => _$seatSeatKindEnumValueOf(name);
}

class SeatFillModeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'direct_election')
  static const SeatFillModeEnum directElection = _$seatFillModeEnum_directElection;
  @BuiltValueEnumConst(wireName: r'delegation')
  static const SeatFillModeEnum delegation = _$seatFillModeEnum_delegation;
  @BuiltValueEnumConst(wireName: r'appointment')
  static const SeatFillModeEnum appointment = _$seatFillModeEnum_appointment;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const SeatFillModeEnum unknownDefaultOpenApi = _$seatFillModeEnum_unknownDefaultOpenApi;

  static Serializer<SeatFillModeEnum> get serializer => _$seatFillModeEnumSerializer;

  const SeatFillModeEnum._(String name): super(name);

  static BuiltSet<SeatFillModeEnum> get values => _$seatFillModeEnumValues;
  static SeatFillModeEnum valueOf(String name) => _$seatFillModeEnumValueOf(name);
}

class SeatHolderCardinalityEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'single')
  static const SeatHolderCardinalityEnum single = _$seatHolderCardinalityEnum_single;
  @BuiltValueEnumConst(wireName: r'multiple')
  static const SeatHolderCardinalityEnum multiple = _$seatHolderCardinalityEnum_multiple;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const SeatHolderCardinalityEnum unknownDefaultOpenApi = _$seatHolderCardinalityEnum_unknownDefaultOpenApi;

  static Serializer<SeatHolderCardinalityEnum> get serializer => _$seatHolderCardinalityEnumSerializer;

  const SeatHolderCardinalityEnum._(String name): super(name);

  static BuiltSet<SeatHolderCardinalityEnum> get values => _$seatHolderCardinalityEnumValues;
  static SeatHolderCardinalityEnum valueOf(String name) => _$seatHolderCardinalityEnumValueOf(name);
}

class SeatStateEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'active')
  static const SeatStateEnum active = _$seatStateEnum_active;
  @BuiltValueEnumConst(wireName: r'retired')
  static const SeatStateEnum retired = _$seatStateEnum_retired;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const SeatStateEnum unknownDefaultOpenApi = _$seatStateEnum_unknownDefaultOpenApi;

  static Serializer<SeatStateEnum> get serializer => _$seatStateEnumSerializer;

  const SeatStateEnum._(String name): super(name);

  static BuiltSet<SeatStateEnum> get values => _$seatStateEnumValues;
  static SeatStateEnum valueOf(String name) => _$seatStateEnumValueOf(name);
}

