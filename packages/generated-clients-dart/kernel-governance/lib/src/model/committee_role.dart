//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'committee_role.g.dart';

/// CommitteeRole
///
/// Properties:
/// * [id] 
/// * [orgUnitId] 
/// * [name] 
/// * [electionMethod] 
/// * [isElected] 
/// * [gracePeriodDays] 
@BuiltValue()
abstract class CommitteeRole implements Built<CommitteeRole, CommitteeRoleBuilder> {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'org_unit_id')
  String get orgUnitId;

  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'election_method')
  CommitteeRoleElectionMethodEnum get electionMethod;
  // enum electionMethodEnum {  helios,  poll,  manual,  };

  @BuiltValueField(wireName: r'is_elected')
  bool get isElected;

  @BuiltValueField(wireName: r'grace_period_days')
  int get gracePeriodDays;

  CommitteeRole._();

  factory CommitteeRole([void updates(CommitteeRoleBuilder b)]) = _$CommitteeRole;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(CommitteeRoleBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<CommitteeRole> get serializer => _$CommitteeRoleSerializer();
}

class _$CommitteeRoleSerializer implements PrimitiveSerializer<CommitteeRole> {
  @override
  final Iterable<Type> types = const [CommitteeRole, _$CommitteeRole];

  @override
  final String wireName = r'CommitteeRole';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    CommitteeRole object, {
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
    yield r'name';
    yield serializers.serialize(
      object.name,
      specifiedType: const FullType(String),
    );
    yield r'election_method';
    yield serializers.serialize(
      object.electionMethod,
      specifiedType: const FullType(CommitteeRoleElectionMethodEnum),
    );
    yield r'is_elected';
    yield serializers.serialize(
      object.isElected,
      specifiedType: const FullType(bool),
    );
    yield r'grace_period_days';
    yield serializers.serialize(
      object.gracePeriodDays,
      specifiedType: const FullType(int),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    CommitteeRole object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required CommitteeRoleBuilder result,
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
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        case r'election_method':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(CommitteeRoleElectionMethodEnum),
          ) as CommitteeRoleElectionMethodEnum;
          result.electionMethod = valueDes;
          break;
        case r'is_elected':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.isElected = valueDes;
          break;
        case r'grace_period_days':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.gracePeriodDays = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  CommitteeRole deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = CommitteeRoleBuilder();
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

class CommitteeRoleElectionMethodEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'helios')
  static const CommitteeRoleElectionMethodEnum helios = _$committeeRoleElectionMethodEnum_helios;
  @BuiltValueEnumConst(wireName: r'poll')
  static const CommitteeRoleElectionMethodEnum poll = _$committeeRoleElectionMethodEnum_poll;
  @BuiltValueEnumConst(wireName: r'manual')
  static const CommitteeRoleElectionMethodEnum manual = _$committeeRoleElectionMethodEnum_manual;

  static Serializer<CommitteeRoleElectionMethodEnum> get serializer => _$committeeRoleElectionMethodEnumSerializer;

  const CommitteeRoleElectionMethodEnum._(String name): super(name);

  static BuiltSet<CommitteeRoleElectionMethodEnum> get values => _$committeeRoleElectionMethodEnumValues;
  static CommitteeRoleElectionMethodEnum valueOf(String name) => _$committeeRoleElectionMethodEnumValueOf(name);
}

