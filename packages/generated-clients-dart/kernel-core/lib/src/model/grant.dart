//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'grant.g.dart';

/// Grant
///
/// Properties:
/// * [grantId] 
/// * [bodyId] 
/// * [subjectPersonId] 
/// * [grantKind] 
/// * [key] 
/// * [resourceKind] 
/// * [resourceId] 
/// * [validFrom] 
/// * [validUntil] 
/// * [granterKind] 
/// * [source_] 
/// * [state] 
/// * [revokedAt] 
/// * [revokeReason] 
/// * [rowVersion] 
@BuiltValue()
abstract class Grant implements Built<Grant, GrantBuilder> {
  @BuiltValueField(wireName: r'grantId')
  String get grantId;

  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'subjectPersonId')
  String get subjectPersonId;

  @BuiltValueField(wireName: r'grantKind')
  GrantGrantKindEnum get grantKind;
  // enum grantKindEnum {  role,  capability,  };

  @BuiltValueField(wireName: r'key')
  String get key;

  @BuiltValueField(wireName: r'resourceKind')
  String? get resourceKind;

  @BuiltValueField(wireName: r'resourceId')
  String? get resourceId;

  @BuiltValueField(wireName: r'validFrom')
  String get validFrom;

  @BuiltValueField(wireName: r'validUntil')
  String? get validUntil;

  @BuiltValueField(wireName: r'granterKind')
  GrantGranterKindEnum get granterKind;
  // enum granterKindEnum {  person,  operator,  system,  };

  @BuiltValueField(wireName: r'source')
  String get source_;

  @BuiltValueField(wireName: r'state')
  GrantStateEnum get state;
  // enum stateEnum {  scheduled,  active,  expired,  revoked,  };

  @BuiltValueField(wireName: r'revokedAt')
  String? get revokedAt;

  @BuiltValueField(wireName: r'revokeReason')
  String? get revokeReason;

  @BuiltValueField(wireName: r'rowVersion')
  int get rowVersion;

  Grant._();

  factory Grant([void updates(GrantBuilder b)]) = _$Grant;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(GrantBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Grant> get serializer => _$GrantSerializer();
}

class _$GrantSerializer implements PrimitiveSerializer<Grant> {
  @override
  final Iterable<Type> types = const [Grant, _$Grant];

  @override
  final String wireName = r'Grant';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Grant object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'grantId';
    yield serializers.serialize(
      object.grantId,
      specifiedType: const FullType(String),
    );
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'subjectPersonId';
    yield serializers.serialize(
      object.subjectPersonId,
      specifiedType: const FullType(String),
    );
    yield r'grantKind';
    yield serializers.serialize(
      object.grantKind,
      specifiedType: const FullType(GrantGrantKindEnum),
    );
    yield r'key';
    yield serializers.serialize(
      object.key,
      specifiedType: const FullType(String),
    );
    if (object.resourceKind != null) {
      yield r'resourceKind';
      yield serializers.serialize(
        object.resourceKind,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.resourceId != null) {
      yield r'resourceId';
      yield serializers.serialize(
        object.resourceId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'validFrom';
    yield serializers.serialize(
      object.validFrom,
      specifiedType: const FullType(String),
    );
    if (object.validUntil != null) {
      yield r'validUntil';
      yield serializers.serialize(
        object.validUntil,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'granterKind';
    yield serializers.serialize(
      object.granterKind,
      specifiedType: const FullType(GrantGranterKindEnum),
    );
    yield r'source';
    yield serializers.serialize(
      object.source_,
      specifiedType: const FullType(String),
    );
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(GrantStateEnum),
    );
    if (object.revokedAt != null) {
      yield r'revokedAt';
      yield serializers.serialize(
        object.revokedAt,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.revokeReason != null) {
      yield r'revokeReason';
      yield serializers.serialize(
        object.revokeReason,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'rowVersion';
    yield serializers.serialize(
      object.rowVersion,
      specifiedType: const FullType(int),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Grant object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required GrantBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'grantId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.grantId = valueDes;
          break;
        case r'bodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'subjectPersonId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.subjectPersonId = valueDes;
          break;
        case r'grantKind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(GrantGrantKindEnum),
          ) as GrantGrantKindEnum;
          result.grantKind = valueDes;
          break;
        case r'key':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.key = valueDes;
          break;
        case r'resourceKind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.resourceKind = valueDes;
          break;
        case r'resourceId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.resourceId = valueDes;
          break;
        case r'validFrom':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.validFrom = valueDes;
          break;
        case r'validUntil':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.validUntil = valueDes;
          break;
        case r'granterKind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(GrantGranterKindEnum),
          ) as GrantGranterKindEnum;
          result.granterKind = valueDes;
          break;
        case r'source':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.source_ = valueDes;
          break;
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(GrantStateEnum),
          ) as GrantStateEnum;
          result.state = valueDes;
          break;
        case r'revokedAt':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.revokedAt = valueDes;
          break;
        case r'revokeReason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.revokeReason = valueDes;
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
  Grant deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = GrantBuilder();
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

class GrantGrantKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'role')
  static const GrantGrantKindEnum role = _$grantGrantKindEnum_role;
  @BuiltValueEnumConst(wireName: r'capability')
  static const GrantGrantKindEnum capability = _$grantGrantKindEnum_capability;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const GrantGrantKindEnum unknownDefaultOpenApi = _$grantGrantKindEnum_unknownDefaultOpenApi;

  static Serializer<GrantGrantKindEnum> get serializer => _$grantGrantKindEnumSerializer;

  const GrantGrantKindEnum._(String name): super(name);

  static BuiltSet<GrantGrantKindEnum> get values => _$grantGrantKindEnumValues;
  static GrantGrantKindEnum valueOf(String name) => _$grantGrantKindEnumValueOf(name);
}

class GrantGranterKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'person')
  static const GrantGranterKindEnum person = _$grantGranterKindEnum_person;
  @BuiltValueEnumConst(wireName: r'operator')
  static const GrantGranterKindEnum operator_ = _$grantGranterKindEnum_operator_;
  @BuiltValueEnumConst(wireName: r'system')
  static const GrantGranterKindEnum system = _$grantGranterKindEnum_system;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const GrantGranterKindEnum unknownDefaultOpenApi = _$grantGranterKindEnum_unknownDefaultOpenApi;

  static Serializer<GrantGranterKindEnum> get serializer => _$grantGranterKindEnumSerializer;

  const GrantGranterKindEnum._(String name): super(name);

  static BuiltSet<GrantGranterKindEnum> get values => _$grantGranterKindEnumValues;
  static GrantGranterKindEnum valueOf(String name) => _$grantGranterKindEnumValueOf(name);
}

class GrantStateEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'scheduled')
  static const GrantStateEnum scheduled = _$grantStateEnum_scheduled;
  @BuiltValueEnumConst(wireName: r'active')
  static const GrantStateEnum active = _$grantStateEnum_active;
  @BuiltValueEnumConst(wireName: r'expired')
  static const GrantStateEnum expired = _$grantStateEnum_expired;
  @BuiltValueEnumConst(wireName: r'revoked')
  static const GrantStateEnum revoked = _$grantStateEnum_revoked;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const GrantStateEnum unknownDefaultOpenApi = _$grantStateEnum_unknownDefaultOpenApi;

  static Serializer<GrantStateEnum> get serializer => _$grantStateEnumSerializer;

  const GrantStateEnum._(String name): super(name);

  static BuiltSet<GrantStateEnum> get values => _$grantStateEnumValues;
  static GrantStateEnum valueOf(String name) => _$grantStateEnumValueOf(name);
}

