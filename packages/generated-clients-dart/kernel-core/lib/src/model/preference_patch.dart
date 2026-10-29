//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'preference_patch.g.dart';

/// PreferencePatch
///
/// Properties:
/// * [locale] 
/// * [displayDensity] 
/// * [colourScheme] 
/// * [lastBodyId] 
@BuiltValue()
abstract class PreferencePatch implements Built<PreferencePatch, PreferencePatchBuilder> {
  @BuiltValueField(wireName: r'locale')
  PreferencePatchLocaleEnum? get locale;
  // enum localeEnum {  de,  en,  follow_customer,  };

  @BuiltValueField(wireName: r'displayDensity')
  PreferencePatchDisplayDensityEnum? get displayDensity;
  // enum displayDensityEnum {  standard,  kompakt,  gross,  };

  @BuiltValueField(wireName: r'colourScheme')
  PreferencePatchColourSchemeEnum? get colourScheme;
  // enum colourSchemeEnum {  system,  light,  dark,  };

  @BuiltValueField(wireName: r'lastBodyId')
  String? get lastBodyId;

  PreferencePatch._();

  factory PreferencePatch([void updates(PreferencePatchBuilder b)]) = _$PreferencePatch;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(PreferencePatchBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<PreferencePatch> get serializer => _$PreferencePatchSerializer();
}

class _$PreferencePatchSerializer implements PrimitiveSerializer<PreferencePatch> {
  @override
  final Iterable<Type> types = const [PreferencePatch, _$PreferencePatch];

  @override
  final String wireName = r'PreferencePatch';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    PreferencePatch object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    if (object.locale != null) {
      yield r'locale';
      yield serializers.serialize(
        object.locale,
        specifiedType: const FullType(PreferencePatchLocaleEnum),
      );
    }
    if (object.displayDensity != null) {
      yield r'displayDensity';
      yield serializers.serialize(
        object.displayDensity,
        specifiedType: const FullType(PreferencePatchDisplayDensityEnum),
      );
    }
    if (object.colourScheme != null) {
      yield r'colourScheme';
      yield serializers.serialize(
        object.colourScheme,
        specifiedType: const FullType(PreferencePatchColourSchemeEnum),
      );
    }
    if (object.lastBodyId != null) {
      yield r'lastBodyId';
      yield serializers.serialize(
        object.lastBodyId,
        specifiedType: const FullType.nullable(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    PreferencePatch object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required PreferencePatchBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'locale':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferencePatchLocaleEnum),
          ) as PreferencePatchLocaleEnum;
          result.locale = valueDes;
          break;
        case r'displayDensity':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferencePatchDisplayDensityEnum),
          ) as PreferencePatchDisplayDensityEnum;
          result.displayDensity = valueDes;
          break;
        case r'colourScheme':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PreferencePatchColourSchemeEnum),
          ) as PreferencePatchColourSchemeEnum;
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
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  PreferencePatch deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = PreferencePatchBuilder();
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

class PreferencePatchLocaleEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'de')
  static const PreferencePatchLocaleEnum de = _$preferencePatchLocaleEnum_de;
  @BuiltValueEnumConst(wireName: r'en')
  static const PreferencePatchLocaleEnum en = _$preferencePatchLocaleEnum_en;
  @BuiltValueEnumConst(wireName: r'follow_customer')
  static const PreferencePatchLocaleEnum followCustomer = _$preferencePatchLocaleEnum_followCustomer;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferencePatchLocaleEnum unknownDefaultOpenApi = _$preferencePatchLocaleEnum_unknownDefaultOpenApi;

  static Serializer<PreferencePatchLocaleEnum> get serializer => _$preferencePatchLocaleEnumSerializer;

  const PreferencePatchLocaleEnum._(String name): super(name);

  static BuiltSet<PreferencePatchLocaleEnum> get values => _$preferencePatchLocaleEnumValues;
  static PreferencePatchLocaleEnum valueOf(String name) => _$preferencePatchLocaleEnumValueOf(name);
}

class PreferencePatchDisplayDensityEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'standard')
  static const PreferencePatchDisplayDensityEnum standard = _$preferencePatchDisplayDensityEnum_standard;
  @BuiltValueEnumConst(wireName: r'kompakt')
  static const PreferencePatchDisplayDensityEnum kompakt = _$preferencePatchDisplayDensityEnum_kompakt;
  @BuiltValueEnumConst(wireName: r'gross')
  static const PreferencePatchDisplayDensityEnum gross = _$preferencePatchDisplayDensityEnum_gross;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferencePatchDisplayDensityEnum unknownDefaultOpenApi = _$preferencePatchDisplayDensityEnum_unknownDefaultOpenApi;

  static Serializer<PreferencePatchDisplayDensityEnum> get serializer => _$preferencePatchDisplayDensityEnumSerializer;

  const PreferencePatchDisplayDensityEnum._(String name): super(name);

  static BuiltSet<PreferencePatchDisplayDensityEnum> get values => _$preferencePatchDisplayDensityEnumValues;
  static PreferencePatchDisplayDensityEnum valueOf(String name) => _$preferencePatchDisplayDensityEnumValueOf(name);
}

class PreferencePatchColourSchemeEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'system')
  static const PreferencePatchColourSchemeEnum system = _$preferencePatchColourSchemeEnum_system;
  @BuiltValueEnumConst(wireName: r'light')
  static const PreferencePatchColourSchemeEnum light = _$preferencePatchColourSchemeEnum_light;
  @BuiltValueEnumConst(wireName: r'dark')
  static const PreferencePatchColourSchemeEnum dark = _$preferencePatchColourSchemeEnum_dark;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const PreferencePatchColourSchemeEnum unknownDefaultOpenApi = _$preferencePatchColourSchemeEnum_unknownDefaultOpenApi;

  static Serializer<PreferencePatchColourSchemeEnum> get serializer => _$preferencePatchColourSchemeEnumSerializer;

  const PreferencePatchColourSchemeEnum._(String name): super(name);

  static BuiltSet<PreferencePatchColourSchemeEnum> get values => _$preferencePatchColourSchemeEnumValues;
  static PreferencePatchColourSchemeEnum valueOf(String name) => _$preferencePatchColourSchemeEnumValueOf(name);
}

