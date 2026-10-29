// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'customer_settings.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const CustomerSettingsDefaultLocaleEnum _$customerSettingsDefaultLocaleEnum_de =
    const CustomerSettingsDefaultLocaleEnum._('de');
const CustomerSettingsDefaultLocaleEnum _$customerSettingsDefaultLocaleEnum_en =
    const CustomerSettingsDefaultLocaleEnum._('en');
const CustomerSettingsDefaultLocaleEnum
    _$customerSettingsDefaultLocaleEnum_unknownDefaultOpenApi =
    const CustomerSettingsDefaultLocaleEnum._('unknownDefaultOpenApi');

CustomerSettingsDefaultLocaleEnum _$customerSettingsDefaultLocaleEnumValueOf(
    String name) {
  switch (name) {
    case 'de':
      return _$customerSettingsDefaultLocaleEnum_de;
    case 'en':
      return _$customerSettingsDefaultLocaleEnum_en;
    case 'unknownDefaultOpenApi':
      return _$customerSettingsDefaultLocaleEnum_unknownDefaultOpenApi;
    default:
      return _$customerSettingsDefaultLocaleEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<CustomerSettingsDefaultLocaleEnum>
    _$customerSettingsDefaultLocaleEnumValues = BuiltSet<
        CustomerSettingsDefaultLocaleEnum>(const <CustomerSettingsDefaultLocaleEnum>[
  _$customerSettingsDefaultLocaleEnum_de,
  _$customerSettingsDefaultLocaleEnum_en,
  _$customerSettingsDefaultLocaleEnum_unknownDefaultOpenApi,
]);

const CustomerSettingsFormOfAddressEnum _$customerSettingsFormOfAddressEnum_du =
    const CustomerSettingsFormOfAddressEnum._('du');
const CustomerSettingsFormOfAddressEnum
    _$customerSettingsFormOfAddressEnum_sie =
    const CustomerSettingsFormOfAddressEnum._('sie');
const CustomerSettingsFormOfAddressEnum
    _$customerSettingsFormOfAddressEnum_unknownDefaultOpenApi =
    const CustomerSettingsFormOfAddressEnum._('unknownDefaultOpenApi');

CustomerSettingsFormOfAddressEnum _$customerSettingsFormOfAddressEnumValueOf(
    String name) {
  switch (name) {
    case 'du':
      return _$customerSettingsFormOfAddressEnum_du;
    case 'sie':
      return _$customerSettingsFormOfAddressEnum_sie;
    case 'unknownDefaultOpenApi':
      return _$customerSettingsFormOfAddressEnum_unknownDefaultOpenApi;
    default:
      return _$customerSettingsFormOfAddressEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<CustomerSettingsFormOfAddressEnum>
    _$customerSettingsFormOfAddressEnumValues = BuiltSet<
        CustomerSettingsFormOfAddressEnum>(const <CustomerSettingsFormOfAddressEnum>[
  _$customerSettingsFormOfAddressEnum_du,
  _$customerSettingsFormOfAddressEnum_sie,
  _$customerSettingsFormOfAddressEnum_unknownDefaultOpenApi,
]);

Serializer<CustomerSettingsDefaultLocaleEnum>
    _$customerSettingsDefaultLocaleEnumSerializer =
    _$CustomerSettingsDefaultLocaleEnumSerializer();
Serializer<CustomerSettingsFormOfAddressEnum>
    _$customerSettingsFormOfAddressEnumSerializer =
    _$CustomerSettingsFormOfAddressEnumSerializer();

class _$CustomerSettingsDefaultLocaleEnumSerializer
    implements PrimitiveSerializer<CustomerSettingsDefaultLocaleEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'de': 'de',
    'en': 'en',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'de': 'de',
    'en': 'en',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[CustomerSettingsDefaultLocaleEnum];
  @override
  final String wireName = 'CustomerSettingsDefaultLocaleEnum';

  @override
  Object serialize(
          Serializers serializers, CustomerSettingsDefaultLocaleEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  CustomerSettingsDefaultLocaleEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      CustomerSettingsDefaultLocaleEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$CustomerSettingsFormOfAddressEnumSerializer
    implements PrimitiveSerializer<CustomerSettingsFormOfAddressEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'du': 'du',
    'sie': 'sie',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'du': 'du',
    'sie': 'sie',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[CustomerSettingsFormOfAddressEnum];
  @override
  final String wireName = 'CustomerSettingsFormOfAddressEnum';

  @override
  Object serialize(
          Serializers serializers, CustomerSettingsFormOfAddressEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  CustomerSettingsFormOfAddressEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      CustomerSettingsFormOfAddressEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$CustomerSettings extends CustomerSettings {
  @override
  final CustomerSettingsDefaultLocaleEnum defaultLocale;
  @override
  final CustomerSettingsFormOfAddressEnum formOfAddress;
  @override
  final String timeZone;

  factory _$CustomerSettings(
          [void Function(CustomerSettingsBuilder)? updates]) =>
      (CustomerSettingsBuilder()..update(updates))._build();

  _$CustomerSettings._(
      {required this.defaultLocale,
      required this.formOfAddress,
      required this.timeZone})
      : super._();
  @override
  CustomerSettings rebuild(void Function(CustomerSettingsBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  CustomerSettingsBuilder toBuilder() =>
      CustomerSettingsBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is CustomerSettings &&
        defaultLocale == other.defaultLocale &&
        formOfAddress == other.formOfAddress &&
        timeZone == other.timeZone;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, defaultLocale.hashCode);
    _$hash = $jc(_$hash, formOfAddress.hashCode);
    _$hash = $jc(_$hash, timeZone.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'CustomerSettings')
          ..add('defaultLocale', defaultLocale)
          ..add('formOfAddress', formOfAddress)
          ..add('timeZone', timeZone))
        .toString();
  }
}

class CustomerSettingsBuilder
    implements Builder<CustomerSettings, CustomerSettingsBuilder> {
  _$CustomerSettings? _$v;

  CustomerSettingsDefaultLocaleEnum? _defaultLocale;
  CustomerSettingsDefaultLocaleEnum? get defaultLocale => _$this._defaultLocale;
  set defaultLocale(CustomerSettingsDefaultLocaleEnum? defaultLocale) =>
      _$this._defaultLocale = defaultLocale;

  CustomerSettingsFormOfAddressEnum? _formOfAddress;
  CustomerSettingsFormOfAddressEnum? get formOfAddress => _$this._formOfAddress;
  set formOfAddress(CustomerSettingsFormOfAddressEnum? formOfAddress) =>
      _$this._formOfAddress = formOfAddress;

  String? _timeZone;
  String? get timeZone => _$this._timeZone;
  set timeZone(String? timeZone) => _$this._timeZone = timeZone;

  CustomerSettingsBuilder() {
    CustomerSettings._defaults(this);
  }

  CustomerSettingsBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _defaultLocale = $v.defaultLocale;
      _formOfAddress = $v.formOfAddress;
      _timeZone = $v.timeZone;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(CustomerSettings other) {
    _$v = other as _$CustomerSettings;
  }

  @override
  void update(void Function(CustomerSettingsBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  CustomerSettings build() => _build();

  _$CustomerSettings _build() {
    final _$result = _$v ??
        _$CustomerSettings._(
          defaultLocale: BuiltValueNullFieldError.checkNotNull(
              defaultLocale, r'CustomerSettings', 'defaultLocale'),
          formOfAddress: BuiltValueNullFieldError.checkNotNull(
              formOfAddress, r'CustomerSettings', 'formOfAddress'),
          timeZone: BuiltValueNullFieldError.checkNotNull(
              timeZone, r'CustomerSettings', 'timeZone'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
