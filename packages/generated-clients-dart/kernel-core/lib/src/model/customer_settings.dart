//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'customer_settings.g.dart';

/// DB-IDT-CUSTOMERSETTING.
///
/// Properties:
/// * [defaultLocale] 
/// * [formOfAddress] 
/// * [timeZone] 
@BuiltValue()
abstract class CustomerSettings implements Built<CustomerSettings, CustomerSettingsBuilder> {
  @BuiltValueField(wireName: r'defaultLocale')
  CustomerSettingsDefaultLocaleEnum get defaultLocale;
  // enum defaultLocaleEnum {  de,  en,  };

  @BuiltValueField(wireName: r'formOfAddress')
  CustomerSettingsFormOfAddressEnum get formOfAddress;
  // enum formOfAddressEnum {  du,  sie,  };

  @BuiltValueField(wireName: r'timeZone')
  String get timeZone;

  CustomerSettings._();

  factory CustomerSettings([void updates(CustomerSettingsBuilder b)]) = _$CustomerSettings;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(CustomerSettingsBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<CustomerSettings> get serializer => _$CustomerSettingsSerializer();
}

class _$CustomerSettingsSerializer implements PrimitiveSerializer<CustomerSettings> {
  @override
  final Iterable<Type> types = const [CustomerSettings, _$CustomerSettings];

  @override
  final String wireName = r'CustomerSettings';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    CustomerSettings object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'defaultLocale';
    yield serializers.serialize(
      object.defaultLocale,
      specifiedType: const FullType(CustomerSettingsDefaultLocaleEnum),
    );
    yield r'formOfAddress';
    yield serializers.serialize(
      object.formOfAddress,
      specifiedType: const FullType(CustomerSettingsFormOfAddressEnum),
    );
    yield r'timeZone';
    yield serializers.serialize(
      object.timeZone,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    CustomerSettings object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required CustomerSettingsBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'defaultLocale':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(CustomerSettingsDefaultLocaleEnum),
          ) as CustomerSettingsDefaultLocaleEnum;
          result.defaultLocale = valueDes;
          break;
        case r'formOfAddress':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(CustomerSettingsFormOfAddressEnum),
          ) as CustomerSettingsFormOfAddressEnum;
          result.formOfAddress = valueDes;
          break;
        case r'timeZone':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.timeZone = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  CustomerSettings deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = CustomerSettingsBuilder();
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

class CustomerSettingsDefaultLocaleEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'de')
  static const CustomerSettingsDefaultLocaleEnum de = _$customerSettingsDefaultLocaleEnum_de;
  @BuiltValueEnumConst(wireName: r'en')
  static const CustomerSettingsDefaultLocaleEnum en = _$customerSettingsDefaultLocaleEnum_en;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const CustomerSettingsDefaultLocaleEnum unknownDefaultOpenApi = _$customerSettingsDefaultLocaleEnum_unknownDefaultOpenApi;

  static Serializer<CustomerSettingsDefaultLocaleEnum> get serializer => _$customerSettingsDefaultLocaleEnumSerializer;

  const CustomerSettingsDefaultLocaleEnum._(String name): super(name);

  static BuiltSet<CustomerSettingsDefaultLocaleEnum> get values => _$customerSettingsDefaultLocaleEnumValues;
  static CustomerSettingsDefaultLocaleEnum valueOf(String name) => _$customerSettingsDefaultLocaleEnumValueOf(name);
}

class CustomerSettingsFormOfAddressEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'du')
  static const CustomerSettingsFormOfAddressEnum du = _$customerSettingsFormOfAddressEnum_du;
  @BuiltValueEnumConst(wireName: r'sie')
  static const CustomerSettingsFormOfAddressEnum sie = _$customerSettingsFormOfAddressEnum_sie;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const CustomerSettingsFormOfAddressEnum unknownDefaultOpenApi = _$customerSettingsFormOfAddressEnum_unknownDefaultOpenApi;

  static Serializer<CustomerSettingsFormOfAddressEnum> get serializer => _$customerSettingsFormOfAddressEnumSerializer;

  const CustomerSettingsFormOfAddressEnum._(String name): super(name);

  static BuiltSet<CustomerSettingsFormOfAddressEnum> get values => _$customerSettingsFormOfAddressEnumValues;
  static CustomerSettingsFormOfAddressEnum valueOf(String name) => _$customerSettingsFormOfAddressEnumValueOf(name);
}

