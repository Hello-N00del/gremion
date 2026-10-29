//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'preference.g.dart';

/// DB-IDT-PREFERENCE of the signed-in person; effectiveLocale resolves follow_customer through idt.customer_setting.default_locale. rowVersion 0 and stored false until the person first saves.
///
/// Properties:
/// * [personId] 
/// * [locale] 
/// * [displayDensity] 
/// * [colourScheme] 
/// * [lastBodyId] 
/// * [rowVersion] 
/// * [updatedByKind] 
/// * [updatedBy] 
/// * [effectiveLocale] 
/// * [stored] 
@BuiltValue()
abstract class Preference implements Built<Preference, PreferenceBuilder> {
  @BuiltValueField(wireName: r'personId')
  String get personId;

  @BuiltValueField(wireName: r'locale')
  PreferenceLocaleEnum get locale;
  // enum localeEnum {  de,  en,  follow_customer,  };

  @BuiltValueField(wireName: r'displayDensity')
  PreferenceDisplayDensityEnum get displayDensity;
  // enum displayDensityEnum {  standard,  kompakt,  gross,  };

  @BuiltValueField(wireName: r'colourScheme')
  PreferenceColourSchemeEnum get colourScheme;
  // enum colourSchemeEnum {  system,  light,  dark,  };

  @BuiltValueField(wireName: r'lastBodyId')
  String? get lastBodyId;

  @BuiltValueField(wireName: r'rowVersion')
  int get rowVersion;

  @BuiltValueField(wireName: r'updatedByKind')
  PreferenceUpdatedByKindEnum get updatedByKind;
  // enum updatedByKindEnum {  person,  system,  };

  @BuiltValueField(wireName: r'updatedBy')
  String? get updatedBy;

  @BuiltValueField(wireName: r'effectiveLocale')
  PreferenceEffectiveLocaleEnum get effectiveLocale;
  // enum effectiveLocaleEnum {  de,  en,  };

  @BuiltValueField(wireName: r'stored')
  bool get stored;

  Preference._();

  factory Preference([void updates(PreferenceBuilder b)]) = _$Preference;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(PreferenceBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<Preference> get serializer => _$PreferenceSerializer();
}

class _$PreferenceSerializer implements PrimitiveSerializer<Preference> {
  @override
  final Iterable<Type> types = const [Preference, _$Preference];

  @override
  final String wireName = r'Preference';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    Preference object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'personId';
    yield serializers.serialize(
      object.personId,
      specifiedType: const FullType(String),
    );
    yield r'locale';
    yield serializers.serialize(
      object.locale,
      specifiedType: const FullType(PreferenceLocaleEnum),
    );
    yield r'displayDensity';
    yield serializers.serialize(
      object.displayDensity,
      specifiedType: const FullType(PreferenceDisplayDensityEnum),
    );
    yield r'colourScheme';
    yield serializers.serialize(
      object.colourScheme,
      specifiedType: const FullType(PreferenceColourSchemeEnum),
    );
    yield r'lastBodyId';
    yield object.lastBodyId == null ? null : serializers.serialize(
      object.lastBodyId,
      specifiedType: const FullType.nullable(String),
    );
    yield r'rowVersion';
    yield serializers.serialize(
      object.rowVersion,
      specifiedType: const FullType(int),
    );
    yield r'updatedByKind';
    yield serializers.serialize(
      object.updatedByKind,
      specifiedType: const FullType(PreferenceUpdatedByKindEnum),
    );
    yield r'updatedBy';
    yield object.updatedBy == null ? null : serializers.serialize(
      object.updatedBy,
      specifiedType: const FullType.nullable(String),
    );
    yield r'effectiveLocale';
    yield serializers.serialize(
      object.effectiveLocale,
      specifiedType: const FullType(PreferenceEffectiveLocaleEnum),
    );
    yield r'stored';
    yield serializers.serialize(
      object.stored,
      specifiedType: const FullType(bool),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    Preference object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required PreferenceBuilder result,
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
        case r'locale':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferenceLocaleEnum),
          ) as PreferenceLocaleEnum;
          result.locale = valueDes;
          break;
        case r'displayDensity':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferenceDisplayDensityEnum),
          ) as PreferenceDisplayDensityEnum;
          result.displayDensity = valueDes;
          break;
        case r'colourScheme':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferenceColourSchemeEnum),
          ) as PreferenceColourSchemeEnum;
          result.colourScheme = valueDes;
          break;
        case r'lastBodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.lastBodyId = valueDes;
          break;
        case r'rowVersion':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.rowVersion = valueDes;
          break;
        case r'updatedByKind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferenceUpdatedByKindEnum),
          ) as PreferenceUpdatedByKindEnum;
          result.updatedByKind = valueDes;
          break;
        case r'updatedBy':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.updatedBy = valueDes;
          break;
        case r'effectiveLocale':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferenceEffectiveLocaleEnum),
          ) as PreferenceEffectiveLocaleEnum;
          result.effectiveLocale = valueDes;
          break;
        case r'stored':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.stored = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  Preference deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = PreferenceBuilder();
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

class PreferenceLocaleEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'de')
  static const PreferenceLocaleEnum de = _$preferenceLocaleEnum_de;
  @BuiltValueEnumConst(wireName: r'en')
  static const PreferenceLocaleEnum en = _$preferenceLocaleEnum_en;
  @BuiltValueEnumConst(wireName: r'follow_customer')
  static const PreferenceLocaleEnum followCustomer = _$preferenceLocaleEnum_followCustomer;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferenceLocaleEnum unknownDefaultOpenApi = _$preferenceLocaleEnum_unknownDefaultOpenApi;

  static Serializer<PreferenceLocaleEnum> get serializer => _$preferenceLocaleEnumSerializer;

  const PreferenceLocaleEnum._(String name): super(name);

  static BuiltSet<PreferenceLocaleEnum> get values => _$preferenceLocaleEnumValues;
  static PreferenceLocaleEnum valueOf(String name) => _$preferenceLocaleEnumValueOf(name);
}

class PreferenceDisplayDensityEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'standard')
  static const PreferenceDisplayDensityEnum standard = _$preferenceDisplayDensityEnum_standard;
  @BuiltValueEnumConst(wireName: r'kompakt')
  static const PreferenceDisplayDensityEnum kompakt = _$preferenceDisplayDensityEnum_kompakt;
  @BuiltValueEnumConst(wireName: r'gross')
  static const PreferenceDisplayDensityEnum gross = _$preferenceDisplayDensityEnum_gross;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferenceDisplayDensityEnum unknownDefaultOpenApi = _$preferenceDisplayDensityEnum_unknownDefaultOpenApi;

  static Serializer<PreferenceDisplayDensityEnum> get serializer => _$preferenceDisplayDensityEnumSerializer;

  const PreferenceDisplayDensityEnum._(String name): super(name);

  static BuiltSet<PreferenceDisplayDensityEnum> get values => _$preferenceDisplayDensityEnumValues;
  static PreferenceDisplayDensityEnum valueOf(String name) => _$preferenceDisplayDensityEnumValueOf(name);
}

class PreferenceColourSchemeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'system')
  static const PreferenceColourSchemeEnum system = _$preferenceColourSchemeEnum_system;
  @BuiltValueEnumConst(wireName: r'light')
  static const PreferenceColourSchemeEnum light = _$preferenceColourSchemeEnum_light;
  @BuiltValueEnumConst(wireName: r'dark')
  static const PreferenceColourSchemeEnum dark = _$preferenceColourSchemeEnum_dark;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferenceColourSchemeEnum unknownDefaultOpenApi = _$preferenceColourSchemeEnum_unknownDefaultOpenApi;

  static Serializer<PreferenceColourSchemeEnum> get serializer => _$preferenceColourSchemeEnumSerializer;

  const PreferenceColourSchemeEnum._(String name): super(name);

  static BuiltSet<PreferenceColourSchemeEnum> get values => _$preferenceColourSchemeEnumValues;
  static PreferenceColourSchemeEnum valueOf(String name) => _$preferenceColourSchemeEnumValueOf(name);
}

class PreferenceUpdatedByKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'person')
  static const PreferenceUpdatedByKindEnum person = _$preferenceUpdatedByKindEnum_person;
  @BuiltValueEnumConst(wireName: r'system')
  static const PreferenceUpdatedByKindEnum system = _$preferenceUpdatedByKindEnum_system;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferenceUpdatedByKindEnum unknownDefaultOpenApi = _$preferenceUpdatedByKindEnum_unknownDefaultOpenApi;

  static Serializer<PreferenceUpdatedByKindEnum> get serializer => _$preferenceUpdatedByKindEnumSerializer;

  const PreferenceUpdatedByKindEnum._(String name): super(name);

  static BuiltSet<PreferenceUpdatedByKindEnum> get values => _$preferenceUpdatedByKindEnumValues;
  static PreferenceUpdatedByKindEnum valueOf(String name) => _$preferenceUpdatedByKindEnumValueOf(name);
}

class PreferenceEffectiveLocaleEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'de')
  static const PreferenceEffectiveLocaleEnum de = _$preferenceEffectiveLocaleEnum_de;
  @BuiltValueEnumConst(wireName: r'en')
  static const PreferenceEffectiveLocaleEnum en = _$preferenceEffectiveLocaleEnum_en;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferenceEffectiveLocaleEnum unknownDefaultOpenApi = _$preferenceEffectiveLocaleEnum_unknownDefaultOpenApi;

  static Serializer<PreferenceEffectiveLocaleEnum> get serializer => _$preferenceEffectiveLocaleEnumSerializer;

  const PreferenceEffectiveLocaleEnum._(String name): super(name);

  static BuiltSet<PreferenceEffectiveLocaleEnum> get values => _$preferenceEffectiveLocaleEnumValues;
  static PreferenceEffectiveLocaleEnum valueOf(String name) => _$preferenceEffectiveLocaleEnumValueOf(name);
}

