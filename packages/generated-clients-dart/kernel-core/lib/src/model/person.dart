//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'person.g.dart';

/// DB-IDT-PERSON. Personal data: served to the person themself only.
///
/// Properties:
/// * [personId] 
/// * [displayName] 
/// * [email] 
/// * [accountState] 
/// * [pseudonym] 
/// * [invitedAt] 
/// * [activatedAt] 
@BuiltValue()
abstract class Person implements Built<Person, PersonBuilder> {
  @BuiltValueField(wireName: r'personId')
  String get personId;

  @BuiltValueField(wireName: r'displayName')
  String? get displayName;

  @BuiltValueField(wireName: r'email')
  String? get email;

  @BuiltValueField(wireName: r'accountState')
  PersonAccountStateEnum get accountState;
  // enum accountStateEnum {  invited,  active,  disabled,  erased,  };

  @BuiltValueField(wireName: r'pseudonym')
  String get pseudonym;

  @BuiltValueField(wireName: r'invitedAt')
  DateTime get invitedAt;

  @BuiltValueField(wireName: r'activatedAt')
  DateTime? get activatedAt;

  Person._();

  factory Person([void updates(PersonBuilder b)]) = _$Person;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(PersonBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Person> get serializer => _$PersonSerializer();
}

class _$PersonSerializer implements PrimitiveSerializer<Person> {
  @override
  final Iterable<Type> types = const [Person, _$Person];

  @override
  final String wireName = r'Person';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Person object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'personId';
    yield serializers.serialize(
      object.personId,
      specifiedType: const FullType(String),
    );
    yield r'displayName';
    yield object.displayName == null ? null : serializers.serialize(
      object.displayName,
      specifiedType: const FullType.nullable(String),
    );
    yield r'email';
    yield object.email == null ? null : serializers.serialize(
      object.email,
      specifiedType: const FullType.nullable(String),
    );
    yield r'accountState';
    yield serializers.serialize(
      object.accountState,
      specifiedType: const FullType(PersonAccountStateEnum),
    );
    yield r'pseudonym';
    yield serializers.serialize(
      object.pseudonym,
      specifiedType: const FullType(String),
    );
    yield r'invitedAt';
    yield serializers.serialize(
      object.invitedAt,
      specifiedType: const FullType(DateTime),
    );
    yield r'activatedAt';
    yield object.activatedAt == null ? null : serializers.serialize(
      object.activatedAt,
      specifiedType: const FullType.nullable(DateTime),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Person object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required PersonBuilder result,
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
        case r'displayName':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.displayName = valueDes;
          break;
        case r'email':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.email = valueDes;
          break;
        case r'accountState':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PersonAccountStateEnum),
          ) as PersonAccountStateEnum;
          result.accountState = valueDes;
          break;
        case r'pseudonym':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.pseudonym = valueDes;
          break;
        case r'invitedAt':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.invitedAt = valueDes;
          break;
        case r'activatedAt':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.activatedAt = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Person deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = PersonBuilder();
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

class PersonAccountStateEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'invited')
  static const PersonAccountStateEnum invited = _$personAccountStateEnum_invited;
  @BuiltValueEnumConst(wireName: r'active')
  static const PersonAccountStateEnum active = _$personAccountStateEnum_active;
  @BuiltValueEnumConst(wireName: r'disabled')
  static const PersonAccountStateEnum disabled = _$personAccountStateEnum_disabled;
  @BuiltValueEnumConst(wireName: r'erased')
  static const PersonAccountStateEnum erased = _$personAccountStateEnum_erased;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PersonAccountStateEnum unknownDefaultOpenApi = _$personAccountStateEnum_unknownDefaultOpenApi;

  static Serializer<PersonAccountStateEnum> get serializer => _$personAccountStateEnumSerializer;

  const PersonAccountStateEnum._(String name): super(name);

  static BuiltSet<PersonAccountStateEnum> get values => _$personAccountStateEnumValues;
  static PersonAccountStateEnum valueOf(String name) => _$personAccountStateEnumValueOf(name);
}

