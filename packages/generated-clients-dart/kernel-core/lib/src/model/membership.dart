//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/date.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'membership.g.dart';

/// DB-IDT-MEMBERSHIP. Carries the person by id only.
///
/// Properties:
/// * [membershipId] 
/// * [personId] 
/// * [orgUnitId] 
/// * [participationKind] 
/// * [voting] 
/// * [validFrom] 
/// * [validUntil] 
/// * [wahlperiodeId] 
/// * [endReason] 
/// * [source_] 
@BuiltValue()
abstract class Membership implements Built<Membership, MembershipBuilder> {
  @BuiltValueField(wireName: r'membershipId')
  String get membershipId;

  @BuiltValueField(wireName: r'personId')
  String get personId;

  @BuiltValueField(wireName: r'orgUnitId')
  String? get orgUnitId;

  @BuiltValueField(wireName: r'participationKind')
  MembershipParticipationKindEnum get participationKind;
  // enum participationKindEnum {  elected_member,  non_voting_helper,  employee,  initiative_member,  initiative_lead,  };

  @BuiltValueField(wireName: r'voting')
  bool get voting;

  @BuiltValueField(wireName: r'validFrom')
  Date get validFrom;

  @BuiltValueField(wireName: r'validUntil')
  Date? get validUntil;

  @BuiltValueField(wireName: r'wahlperiodeId')
  String? get wahlperiodeId;

  @BuiltValueField(wireName: r'endReason')
  MembershipEndReasonEnum? get endReason;
  // enum endReasonEnum {  term_end,  resigned,  removed,  data_correction,  };

  @BuiltValueField(wireName: r'source')
  MembershipSource_Enum get source_;
  // enum source_Enum {  admin,  control_panel,  import,  provisioning,  };

  Membership._();

  factory Membership([void updates(MembershipBuilder b)]) = _$Membership;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MembershipBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Membership> get serializer => _$MembershipSerializer();
}

class _$MembershipSerializer implements PrimitiveSerializer<Membership> {
  @override
  final Iterable<Type> types = const [Membership, _$Membership];

  @override
  final String wireName = r'Membership';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Membership object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'membershipId';
    yield serializers.serialize(
      object.membershipId,
      specifiedType: const FullType(String),
    );
    yield r'personId';
    yield serializers.serialize(
      object.personId,
      specifiedType: const FullType(String),
    );
    yield r'orgUnitId';
    yield object.orgUnitId == null ? null : serializers.serialize(
      object.orgUnitId,
      specifiedType: const FullType.nullable(String),
    );
    yield r'participationKind';
    yield serializers.serialize(
      object.participationKind,
      specifiedType: const FullType(MembershipParticipationKindEnum),
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
    yield r'validUntil';
    yield object.validUntil == null ? null : serializers.serialize(
      object.validUntil,
      specifiedType: const FullType.nullable(Date),
    );
    yield r'wahlperiodeId';
    yield object.wahlperiodeId == null ? null : serializers.serialize(
      object.wahlperiodeId,
      specifiedType: const FullType.nullable(String),
    );
    yield r'endReason';
    yield object.endReason == null ? null : serializers.serialize(
      object.endReason,
      specifiedType: const FullType.nullable(MembershipEndReasonEnum),
    );
    yield r'source';
    yield serializers.serialize(
      object.source_,
      specifiedType: const FullType(MembershipSource_Enum),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Membership object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MembershipBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'membershipId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.membershipId = valueDes;
          break;
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
            specifiedType: const FullType(MembershipParticipationKindEnum),
          ) as MembershipParticipationKindEnum;
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
        case r'endReason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(MembershipEndReasonEnum),
          ) as MembershipEndReasonEnum?;
          if (valueDes == null) continue;
          result.endReason = valueDes;
          break;
        case r'source':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(MembershipSource_Enum),
          ) as MembershipSource_Enum;
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
  Membership deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MembershipBuilder();
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

class MembershipParticipationKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'elected_member')
  static const MembershipParticipationKindEnum electedMember = _$membershipParticipationKindEnum_electedMember;
  @BuiltValueEnumConst(wireName: r'non_voting_helper')
  static const MembershipParticipationKindEnum nonVotingHelper = _$membershipParticipationKindEnum_nonVotingHelper;
  @BuiltValueEnumConst(wireName: r'employee')
  static const MembershipParticipationKindEnum employee = _$membershipParticipationKindEnum_employee;
  @BuiltValueEnumConst(wireName: r'initiative_member')
  static const MembershipParticipationKindEnum initiativeMember = _$membershipParticipationKindEnum_initiativeMember;
  @BuiltValueEnumConst(wireName: r'initiative_lead')
  static const MembershipParticipationKindEnum initiativeLead = _$membershipParticipationKindEnum_initiativeLead;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MembershipParticipationKindEnum unknownDefaultOpenApi = _$membershipParticipationKindEnum_unknownDefaultOpenApi;

  static Serializer<MembershipParticipationKindEnum> get serializer => _$membershipParticipationKindEnumSerializer;

  const MembershipParticipationKindEnum._(String name): super(name);

  static BuiltSet<MembershipParticipationKindEnum> get values => _$membershipParticipationKindEnumValues;
  static MembershipParticipationKindEnum valueOf(String name) => _$membershipParticipationKindEnumValueOf(name);
}

class MembershipEndReasonEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'term_end')
  static const MembershipEndReasonEnum termEnd = _$membershipEndReasonEnum_termEnd;
  @BuiltValueEnumConst(wireName: r'resigned')
  static const MembershipEndReasonEnum resigned = _$membershipEndReasonEnum_resigned;
  @BuiltValueEnumConst(wireName: r'removed')
  static const MembershipEndReasonEnum removed = _$membershipEndReasonEnum_removed;
  @BuiltValueEnumConst(wireName: r'data_correction')
  static const MembershipEndReasonEnum dataCorrection = _$membershipEndReasonEnum_dataCorrection;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MembershipEndReasonEnum unknownDefaultOpenApi = _$membershipEndReasonEnum_unknownDefaultOpenApi;

  static Serializer<MembershipEndReasonEnum> get serializer => _$membershipEndReasonEnumSerializer;

  const MembershipEndReasonEnum._(String name): super(name);

  static BuiltSet<MembershipEndReasonEnum> get values => _$membershipEndReasonEnumValues;
  static MembershipEndReasonEnum valueOf(String name) => _$membershipEndReasonEnumValueOf(name);
}

class MembershipSource_Enum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'admin')
  static const MembershipSource_Enum admin = _$membershipSourceEnum_admin;
  @BuiltValueEnumConst(wireName: r'control_panel')
  static const MembershipSource_Enum controlPanel = _$membershipSourceEnum_controlPanel;
  @BuiltValueEnumConst(wireName: r'import')
  static const MembershipSource_Enum import_ = _$membershipSourceEnum_import_;
  @BuiltValueEnumConst(wireName: r'provisioning')
  static const MembershipSource_Enum provisioning = _$membershipSourceEnum_provisioning;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const MembershipSource_Enum unknownDefaultOpenApi = _$membershipSourceEnum_unknownDefaultOpenApi;

  static Serializer<MembershipSource_Enum> get serializer => _$membershipSourceEnumSerializer;

  const MembershipSource_Enum._(String name): super(name);

  static BuiltSet<MembershipSource_Enum> get values => _$membershipSourceEnumValues;
  static MembershipSource_Enum valueOf(String name) => _$membershipSourceEnumValueOf(name);
}

