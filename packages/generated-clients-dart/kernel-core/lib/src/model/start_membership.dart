//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/date.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'start_membership.g.dart';

/// StartMembership
///
/// Properties:
/// * [personId] 
/// * [orgUnitId] 
/// * [participationKind] 
/// * [voting] 
/// * [validFrom] 
/// * [validUntil] 
/// * [wahlperiodeId] 
@BuiltValue()
abstract class StartMembership implements Built<StartMembership, StartMembershipBuilder> {
  @BuiltValueField(wireName: r'personId')
  String get personId;

  @BuiltValueField(wireName: r'orgUnitId')
  String? get orgUnitId;

  @BuiltValueField(wireName: r'participationKind')
  StartMembershipParticipationKindEnum get participationKind;
  // enum participationKindEnum {  elected_member,  non_voting_helper,  employee,  initiative_member,  initiative_lead,  };

  @BuiltValueField(wireName: r'voting')
  bool get voting;

  @BuiltValueField(wireName: r'validFrom')
  Date get validFrom;

  @BuiltValueField(wireName: r'validUntil')
  Date? get validUntil;

  @BuiltValueField(wireName: r'wahlperiodeId')
  String? get wahlperiodeId;

  StartMembership._();

  factory StartMembership([void updates(StartMembershipBuilder b)]) = _$StartMembership;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(StartMembershipBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<StartMembership> get serializer => _$StartMembershipSerializer();
}

class _$StartMembershipSerializer implements PrimitiveSerializer<StartMembership> {
  @override
  final Iterable<Type> types = const [StartMembership, _$StartMembership];

  @override
  final String wireName = r'StartMembership';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    StartMembership object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'personId';
    yield serializers.serialize(
      object.personId,
      specifiedType: const FullType(String),
    );
    if (object.orgUnitId != null) {
      yield r'orgUnitId';
      yield serializers.serialize(
        object.orgUnitId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'participationKind';
    yield serializers.serialize(
      object.participationKind,
      specifiedType: const FullType(StartMembershipParticipationKindEnum),
    );
    yield r'voting';
    yield serializers.serialize(
      object.voting,
      specifiedType: const FullType(bool),
    );
    yield r'validFrom';
    yield serializers.serialize(
      object.validFrom,
      specifiedType: const FullType(Date),
    );
    if (object.validUntil != null) {
      yield r'validUntil';
      yield serializers.serialize(
        object.validUntil,
        specifiedType: const FullType.nullable(Date),
      );
    }
    if (object.wahlperiodeId != null) {
      yield r'wahlperiodeId';
      yield serializers.serialize(
        object.wahlperiodeId,
        specifiedType: const FullType.nullable(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    StartMembership object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required StartMembershipBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'personId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.personId = valueDes;
          break;
        case r'orgUnitId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.orgUnitId = valueDes;
          break;
        case r'participationKind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(StartMembershipParticipationKindEnum),
          ) as StartMembershipParticipationKindEnum;
          result.participationKind = valueDes;
          break;
        case r'voting':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.voting = valueDes;
          break;
        case r'validFrom':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(Date),
          ) as Date;
          result.validFrom = valueDes;
          break;
        case r'validUntil':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.validUntil = valueDes;
          break;
        case r'wahlperiodeId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.wahlperiodeId = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  StartMembership deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = StartMembershipBuilder();
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

class StartMembershipParticipationKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'elected_member')
  static const StartMembershipParticipationKindEnum electedMember = _$startMembershipParticipationKindEnum_electedMember;
  @BuiltValueEnumConst(wireName: r'non_voting_helper')
  static const StartMembershipParticipationKindEnum nonVotingHelper = _$startMembershipParticipationKindEnum_nonVotingHelper;
  @BuiltValueEnumConst(wireName: r'employee')
  static const StartMembershipParticipationKindEnum employee = _$startMembershipParticipationKindEnum_employee;
  @BuiltValueEnumConst(wireName: r'initiative_member')
  static const StartMembershipParticipationKindEnum initiativeMember = _$startMembershipParticipationKindEnum_initiativeMember;
  @BuiltValueEnumConst(wireName: r'initiative_lead')
  static const StartMembershipParticipationKindEnum initiativeLead = _$startMembershipParticipationKindEnum_initiativeLead;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const StartMembershipParticipationKindEnum unknownDefaultOpenApi = _$startMembershipParticipationKindEnum_unknownDefaultOpenApi;

  static Serializer<StartMembershipParticipationKindEnum> get serializer => _$startMembershipParticipationKindEnumSerializer;

  const StartMembershipParticipationKindEnum._(String name): super(name);

  static BuiltSet<StartMembershipParticipationKindEnum> get values => _$startMembershipParticipationKindEnumValues;
  static StartMembershipParticipationKindEnum valueOf(String name) => _$startMembershipParticipationKindEnumValueOf(name);
}

