//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/date.dart';
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_governance_client/src/model/org_unit_member.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'committee_member.g.dart';

/// OrgUnitMember enriched with Keycloak display name and email (null on lookup failure)
///
/// Properties:
/// * [id] 
/// * [orgUnitId] 
/// * [userKeycloakId] 
/// * [membershipType] 
/// * [termStart] 
/// * [termEnd] 
/// * [voting] - Member sits with a vote; sachkundige Bürger sit without one (P2.2 #202, §3.5(d)); NOT NULL DEFAULT true (migration 038)
/// * [joinedAt] 
/// * [email] 
/// * [name] 
@BuiltValue()
abstract class CommitteeMember implements OrgUnitMember, Built<CommitteeMember, CommitteeMemberBuilder> {
  @BuiltValueField(wireName: r'name')
  String? get name;

  @BuiltValueField(wireName: r'email')
  String? get email;

  CommitteeMember._();

  factory CommitteeMember([void updates(CommitteeMemberBuilder b)]) = _$CommitteeMember;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(CommitteeMemberBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<CommitteeMember> get serializer => _$CommitteeMemberSerializer();
}

class _$CommitteeMemberSerializer implements PrimitiveSerializer<CommitteeMember> {
  @override
  final Iterable<Type> types = const [CommitteeMember, _$CommitteeMember];

  @override
  final String wireName = r'CommitteeMember';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    CommitteeMember object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'user_keycloak_id';
    yield serializers.serialize(
      object.userKeycloakId,
      specifiedType: const FullType(String),
    );
    yield r'membership_type';
    yield serializers.serialize(
      object.membershipType,
      specifiedType: const FullType(OrgUnitMemberMembershipTypeEnum),
    );
    if (object.termStart != null) {
      yield r'term_start';
      yield serializers.serialize(
        object.termStart,
        specifiedType: const FullType.nullable(Date),
      );
    }
    yield r'joined_at';
    yield serializers.serialize(
      object.joinedAt,
      specifiedType: const FullType(DateTime),
    );
    if (object.name != null) {
      yield r'name';
      yield serializers.serialize(
        object.name,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'voting';
    yield serializers.serialize(
      object.voting,
      specifiedType: const FullType(bool),
    );
    if (object.termEnd != null) {
      yield r'term_end';
      yield serializers.serialize(
        object.termEnd,
        specifiedType: const FullType.nullable(Date),
      );
    }
    yield r'id';
    yield serializers.serialize(
      object.id,
      specifiedType: const FullType(String),
    );
    yield r'org_unit_id';
    yield serializers.serialize(
      object.orgUnitId,
      specifiedType: const FullType(String),
    );
    if (object.email != null) {
      yield r'email';
      yield serializers.serialize(
        object.email,
        specifiedType: const FullType.nullable(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    CommitteeMember object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required CommitteeMemberBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'user_keycloak_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.userKeycloakId = valueDes;
          break;
        case r'membership_type':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(OrgUnitMemberMembershipTypeEnum),
          ) as OrgUnitMemberMembershipTypeEnum;
          result.membershipType = valueDes;
          break;
        case r'term_start':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.termStart = valueDes;
          break;
        case r'joined_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.joinedAt = valueDes;
          break;
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.name = valueDes;
          break;
        case r'voting':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.voting = valueDes;
          break;
        case r'term_end':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.termEnd = valueDes;
          break;
        case r'id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.id = valueDes;
          break;
        case r'org_unit_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.orgUnitId = valueDes;
          break;
        case r'email':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.email = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  CommitteeMember deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = CommitteeMemberBuilder();
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

class CommitteeMemberMembershipTypeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'elected')
  static const CommitteeMemberMembershipTypeEnum elected = _$committeeMemberMembershipTypeEnum_elected;
  @BuiltValueEnumConst(wireName: r'unelected')
  static const CommitteeMemberMembershipTypeEnum unelected = _$committeeMemberMembershipTypeEnum_unelected;
  @BuiltValueEnumConst(wireName: r'employee')
  static const CommitteeMemberMembershipTypeEnum employee = _$committeeMemberMembershipTypeEnum_employee;

  static Serializer<CommitteeMemberMembershipTypeEnum> get serializer => _$committeeMemberMembershipTypeEnumSerializer;

  const CommitteeMemberMembershipTypeEnum._(String name): super(name);

  static BuiltSet<CommitteeMemberMembershipTypeEnum> get values => _$committeeMemberMembershipTypeEnumValues;
  static CommitteeMemberMembershipTypeEnum valueOf(String name) => _$committeeMemberMembershipTypeEnumValueOf(name);
}

