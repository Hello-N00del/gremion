//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'org_unit.g.dart';

/// DB-IDT-ORGUNIT: a unit of a body.
///
/// Properties:
/// * [orgUnitId] 
/// * [bodyId] 
/// * [parentOrgUnitId] 
/// * [kindKey] 
/// * [name] 
/// * [isOrgan] 
/// * [state] 
/// * [rowVersion] 
@BuiltValue()
abstract class OrgUnit implements Built<OrgUnit, OrgUnitBuilder> {
  @BuiltValueField(wireName: r'orgUnitId')
  String get orgUnitId;

  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'parentOrgUnitId')
  String? get parentOrgUnitId;

  @BuiltValueField(wireName: r'kindKey')
  String get kindKey;

  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'isOrgan')
  bool get isOrgan;

  @BuiltValueField(wireName: r'state')
  OrgUnitStateEnum get state;
  // enum stateEnum {  active,  archived,  };

  @BuiltValueField(wireName: r'rowVersion')
  int get rowVersion;

  OrgUnit._();

  factory OrgUnit([void updates(OrgUnitBuilder b)]) = _$OrgUnit;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(OrgUnitBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<OrgUnit> get serializer => _$OrgUnitSerializer();
}

class _$OrgUnitSerializer implements PrimitiveSerializer<OrgUnit> {
  @override
  final Iterable<Type> types = const [OrgUnit, _$OrgUnit];

  @override
  final String wireName = r'OrgUnit';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    OrgUnit object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'orgUnitId';
    yield serializers.serialize(
      object.orgUnitId,
      specifiedType: const FullType(String),
    );
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'parentOrgUnitId';
    yield object.parentOrgUnitId == null ? null : serializers.serialize(
      object.parentOrgUnitId,
      specifiedType: const FullType.nullable(String),
    );
    yield r'kindKey';
    yield serializers.serialize(
      object.kindKey,
      specifiedType: const FullType(String),
    );
    yield r'name';
    yield serializers.serialize(
      object.name,
      specifiedType: const FullType(String),
    );
    yield r'isOrgan';
    yield serializers.serialize(
      object.isOrgan,
      specifiedType: const FullType(bool),
    );
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(OrgUnitStateEnum),
    );
    yield r'rowVersion';
    yield serializers.serialize(
      object.rowVersion,
      specifiedType: const FullType(int),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    OrgUnit object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required OrgUnitBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'orgUnitId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.orgUnitId = valueDes;
          break;
        case r'bodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'parentOrgUnitId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.parentOrgUnitId = valueDes;
          break;
        case r'kindKey':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.kindKey = valueDes;
          break;
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        case r'isOrgan':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.isOrgan = valueDes;
          break;
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(OrgUnitStateEnum),
          ) as OrgUnitStateEnum;
          result.state = valueDes;
          break;
        case r'rowVersion':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.rowVersion = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  OrgUnit deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = OrgUnitBuilder();
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

class OrgUnitStateEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'active')
  static const OrgUnitStateEnum active = _$orgUnitStateEnum_active;
  @BuiltValueEnumConst(wireName: r'archived')
  static const OrgUnitStateEnum archived = _$orgUnitStateEnum_archived;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const OrgUnitStateEnum unknownDefaultOpenApi = _$orgUnitStateEnum_unknownDefaultOpenApi;

  static Serializer<OrgUnitStateEnum> get serializer => _$orgUnitStateEnumSerializer;

  const OrgUnitStateEnum._(String name): super(name);

  static BuiltSet<OrgUnitStateEnum> get values => _$orgUnitStateEnumValues;
  static OrgUnitStateEnum valueOf(String name) => _$orgUnitStateEnumValueOf(name);
}

