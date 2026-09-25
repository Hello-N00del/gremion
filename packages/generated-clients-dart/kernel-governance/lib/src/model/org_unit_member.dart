//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/date.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'org_unit_member.g.dart';

/// OrgUnitMember
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
@BuiltValue(instantiable: false)
abstract class OrgUnitMember  {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'org_unit_id')
  String get orgUnitId;

  @BuiltValueField(wireName: r'user_keycloak_id')
  String get userKeycloakId;

  @BuiltValueField(wireName: r'membership_type')
  OrgUnitMemberMembershipTypeEnum get membershipType;
  // enum membershipTypeEnum {  elected,  unelected,  employee,  };

  @BuiltValueField(wireName: r'term_start')
  Date? get termStart;

  @BuiltValueField(wireName: r'term_end')
  Date? get termEnd;

  /// Member sits with a vote; sachkundige Bürger sit without one (P2.2 #202, §3.5(d)); NOT NULL DEFAULT true (migration 038)
  @BuiltValueField(wireName: r'voting')
  bool get voting;

  @BuiltValueField(wireName: r'joined_at')
  DateTime get joinedAt;

  @BuiltValueSerializer(custom: true)
  static Serializer<OrgUnitMember> get serializer => _$OrgUnitMemberSerializer();
}

class _$OrgUnitMemberSerializer implements PrimitiveSerializer<OrgUnitMember> {
  @override
  final Iterable<Type> types = const [OrgUnitMember];

  @override
  final String wireName = r'OrgUnitMember';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    OrgUnitMember object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
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
    if (object.termEnd != null) {
      yield r'term_end';
      yield serializers.serialize(
        object.termEnd,
        specifiedType: const FullType.nullable(Date),
      );
    }
    yield r'voting';
    yield serializers.serialize(
      object.voting,
      specifiedType: const FullType(bool),
    );
    yield r'joined_at';
    yield serializers.serialize(
      object.joinedAt,
      specifiedType: const FullType(DateTime),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    OrgUnitMember object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  @override
  OrgUnitMember deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return serializers.deserialize(serialized, specifiedType: FullType($OrgUnitMember)) as $OrgUnitMember;
  }
}

/// a concrete implementation of [OrgUnitMember], since [OrgUnitMember] is not instantiable
@BuiltValue(instantiable: true)
abstract class $OrgUnitMember implements OrgUnitMember, Built<$OrgUnitMember, $OrgUnitMemberBuilder> {
  $OrgUnitMember._();

  factory $OrgUnitMember([void Function($OrgUnitMemberBuilder)? updates]) = _$$OrgUnitMember;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults($OrgUnitMemberBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<$OrgUnitMember> get serializer => _$$OrgUnitMemberSerializer();
}

class _$$OrgUnitMemberSerializer implements PrimitiveSerializer<$OrgUnitMember> {
  @override
  final Iterable<Type> types = const [$OrgUnitMember, _$$OrgUnitMember];

  @override
  final String wireName = r'$OrgUnitMember';

  @override
  Object serialize(
    Serializers serializers,
    $OrgUnitMember object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return serializers.serialize(object, specifiedType: FullType(OrgUnitMember))!;
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required OrgUnitMemberBuilder result,
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
        case r'org_unit_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.orgUnitId = valueDes;
          break;
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
        case r'term_end':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(Date),
          ) as Date?;
          if (valueDes == null) continue;
          result.termEnd = valueDes;
          break;
        case r'voting':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.voting = valueDes;
          break;
        case r'joined_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.joinedAt = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  $OrgUnitMember deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = $OrgUnitMemberBuilder();
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

class OrgUnitMemberMembershipTypeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'elected')
  static const OrgUnitMemberMembershipTypeEnum elected = _$orgUnitMemberMembershipTypeEnum_elected;
  @BuiltValueEnumConst(wireName: r'unelected')
  static const OrgUnitMemberMembershipTypeEnum unelected = _$orgUnitMemberMembershipTypeEnum_unelected;
  @BuiltValueEnumConst(wireName: r'employee')
  static const OrgUnitMemberMembershipTypeEnum employee = _$orgUnitMemberMembershipTypeEnum_employee;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const OrgUnitMemberMembershipTypeEnum unknownDefaultOpenApi = _$orgUnitMemberMembershipTypeEnum_unknownDefaultOpenApi;

  static Serializer<OrgUnitMemberMembershipTypeEnum> get serializer => _$orgUnitMemberMembershipTypeEnumSerializer;

  const OrgUnitMemberMembershipTypeEnum._(String name): super(name);

  static BuiltSet<OrgUnitMemberMembershipTypeEnum> get values => _$orgUnitMemberMembershipTypeEnumValues;
  static OrgUnitMemberMembershipTypeEnum valueOf(String name) => _$orgUnitMemberMembershipTypeEnumValueOf(name);
}

