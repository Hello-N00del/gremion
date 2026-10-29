// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'preference_patch.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const PreferencePatchLocaleEnum _$preferencePatchLocaleEnum_de =
    const PreferencePatchLocaleEnum._('de');
const PreferencePatchLocaleEnum _$preferencePatchLocaleEnum_en =
    const PreferencePatchLocaleEnum._('en');
const PreferencePatchLocaleEnum _$preferencePatchLocaleEnum_followCustomer =
    const PreferencePatchLocaleEnum._('followCustomer');
const PreferencePatchLocaleEnum
    _$preferencePatchLocaleEnum_unknownDefaultOpenApi =
    const PreferencePatchLocaleEnum._('unknownDefaultOpenApi');

PreferencePatchLocaleEnum _$preferencePatchLocaleEnumValueOf(String name) {
  switch (name) {
    case 'de':
      return _$preferencePatchLocaleEnum_de;
    case 'en':
      return _$preferencePatchLocaleEnum_en;
    case 'followCustomer':
      return _$preferencePatchLocaleEnum_followCustomer;
    case 'unknownDefaultOpenApi':
      return _$preferencePatchLocaleEnum_unknownDefaultOpenApi;
    default:
      return _$preferencePatchLocaleEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<PreferencePatchLocaleEnum> _$preferencePatchLocaleEnumValues =
    BuiltSet<PreferencePatchLocaleEnum>(const <PreferencePatchLocaleEnum>[
  _$preferencePatchLocaleEnum_de,
  _$preferencePatchLocaleEnum_en,
  _$preferencePatchLocaleEnum_followCustomer,
  _$preferencePatchLocaleEnum_unknownDefaultOpenApi,
]);

const PreferencePatchDisplayDensityEnum
    _$preferencePatchDisplayDensityEnum_standard =
    const PreferencePatchDisplayDensityEnum._('standard');
const PreferencePatchDisplayDensityEnum
    _$preferencePatchDisplayDensityEnum_kompakt =
    const PreferencePatchDisplayDensityEnum._('kompakt');
const PreferencePatchDisplayDensityEnum
    _$preferencePatchDisplayDensityEnum_gross =
    const PreferencePatchDisplayDensityEnum._('gross');
const PreferencePatchDisplayDensityEnum
    _$preferencePatchDisplayDensityEnum_unknownDefaultOpenApi =
    const PreferencePatchDisplayDensityEnum._('unknownDefaultOpenApi');

PreferencePatchDisplayDensityEnum _$preferencePatchDisplayDensityEnumValueOf(
    String name) {
  switch (name) {
    case 'standard':
      return _$preferencePatchDisplayDensityEnum_standard;
    case 'kompakt':
      return _$preferencePatchDisplayDensityEnum_kompakt;
    case 'gross':
      return _$preferencePatchDisplayDensityEnum_gross;
    case 'unknownDefaultOpenApi':
      return _$preferencePatchDisplayDensityEnum_unknownDefaultOpenApi;
    default:
      return _$preferencePatchDisplayDensityEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<PreferencePatchDisplayDensityEnum>
    _$preferencePatchDisplayDensityEnumValues = BuiltSet<
        PreferencePatchDisplayDensityEnum>(const <PreferencePatchDisplayDensityEnum>[
  _$preferencePatchDisplayDensityEnum_standard,
  _$preferencePatchDisplayDensityEnum_kompakt,
  _$preferencePatchDisplayDensityEnum_gross,
  _$preferencePatchDisplayDensityEnum_unknownDefaultOpenApi,
]);

const PreferencePatchColourSchemeEnum _$preferencePatchColourSchemeEnum_system =
    const PreferencePatchColourSchemeEnum._('system');
const PreferencePatchColourSchemeEnum _$preferencePatchColourSchemeEnum_light =
    const PreferencePatchColourSchemeEnum._('light');
const PreferencePatchColourSchemeEnum _$preferencePatchColourSchemeEnum_dark =
    const PreferencePatchColourSchemeEnum._('dark');
const PreferencePatchColourSchemeEnum
    _$preferencePatchColourSchemeEnum_unknownDefaultOpenApi =
    const PreferencePatchColourSchemeEnum._('unknownDefaultOpenApi');

PreferencePatchColourSchemeEnum _$preferencePatchColourSchemeEnumValueOf(
    String name) {
  switch (name) {
    case 'system':
      return _$preferencePatchColourSchemeEnum_system;
    case 'light':
      return _$preferencePatchColourSchemeEnum_light;
    case 'dark':
      return _$preferencePatchColourSchemeEnum_dark;
    case 'unknownDefaultOpenApi':
      return _$preferencePatchColourSchemeEnum_unknownDefaultOpenApi;
    default:
      return _$preferencePatchColourSchemeEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<PreferencePatchColourSchemeEnum>
    _$preferencePatchColourSchemeEnumValues = BuiltSet<
        PreferencePatchColourSchemeEnum>(const <PreferencePatchColourSchemeEnum>[
  _$preferencePatchColourSchemeEnum_system,
  _$preferencePatchColourSchemeEnum_light,
  _$preferencePatchColourSchemeEnum_dark,
  _$preferencePatchColourSchemeEnum_unknownDefaultOpenApi,
]);

Serializer<PreferencePatchLocaleEnum> _$preferencePatchLocaleEnumSerializer =
    _$PreferencePatchLocaleEnumSerializer();
Serializer<PreferencePatchDisplayDensityEnum>
    _$preferencePatchDisplayDensityEnumSerializer =
    _$PreferencePatchDisplayDensityEnumSerializer();
Serializer<PreferencePatchColourSchemeEnum>
    _$preferencePatchColourSchemeEnumSerializer =
    _$PreferencePatchColourSchemeEnumSerializer();

class _$PreferencePatchLocaleEnumSerializer
    implements PrimitiveSerializer<PreferencePatchLocaleEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'de': 'de',
    'en': 'en',
    'followCustomer': 'follow_customer',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'de': 'de',
    'en': 'en',
    'follow_customer': 'followCustomer',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[PreferencePatchLocaleEnum];
  @override
  final String wireName = 'PreferencePatchLocaleEnum';

  @override
  Object serialize(Serializers serializers, PreferencePatchLocaleEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  PreferencePatchLocaleEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      PreferencePatchLocaleEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$PreferencePatchDisplayDensityEnumSerializer
    implements PrimitiveSerializer<PreferencePatchDisplayDensityEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'standard': 'standard',
    'kompakt': 'kompakt',
    'gross': 'gross',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'standard': 'standard',
    'kompakt': 'kompakt',
    'gross': 'gross',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[PreferencePatchDisplayDensityEnum];
  @override
  final String wireName = 'PreferencePatchDisplayDensityEnum';

  @override
  Object serialize(
          Serializers serializers, PreferencePatchDisplayDensityEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  PreferencePatchDisplayDensityEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      PreferencePatchDisplayDensityEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$PreferencePatchColourSchemeEnumSerializer
    implements PrimitiveSerializer<PreferencePatchColourSchemeEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'system': 'system',
    'light': 'light',
    'dark': 'dark',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'system': 'system',
    'light': 'light',
    'dark': 'dark',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[PreferencePatchColourSchemeEnum];
  @override
  final String wireName = 'PreferencePatchColourSchemeEnum';

  @override
  Object serialize(
          Serializers serializers, PreferencePatchColourSchemeEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  PreferencePatchColourSchemeEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      PreferencePatchColourSchemeEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$PreferencePatch extends PreferencePatch {
  @override
  final PreferencePatchLocaleEnum? locale;
  @override
  final PreferencePatchDisplayDensityEnum? displayDensity;
  @override
  final PreferencePatchColourSchemeEnum? colourScheme;
  @override
  final String? lastBodyId;

  factory _$PreferencePatch([void Function(PreferencePatchBuilder)? updates]) =>
      (PreferencePatchBuilder()..update(updates))._build();

  _$PreferencePatch._(
      {this.locale, this.displayDensity, this.colourScheme, this.lastBodyId})
      : super._();
  @override
  PreferencePatch rebuild(void Function(PreferencePatchBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  PreferencePatchBuilder toBuilder() => PreferencePatchBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is PreferencePatch &&
        locale == other.locale &&
        displayDensity == other.displayDensity &&
        colourScheme == other.colourScheme &&
        lastBodyId == other.lastBodyId;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, locale.hashCode);
    _$hash = $jc(_$hash, displayDensity.hashCode);
    _$hash = $jc(_$hash, colourScheme.hashCode);
    _$hash = $jc(_$hash, lastBodyId.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'PreferencePatch')
          ..add('locale', locale)
          ..add('displayDensity', displayDensity)
          ..add('colourScheme', colourScheme)
          ..add('lastBodyId', lastBodyId))
        .toString();
  }
}

class PreferencePatchBuilder
    implements Builder<PreferencePatch, PreferencePatchBuilder> {
  _$PreferencePatch? _$v;

  PreferencePatchLocaleEnum? _locale;
  PreferencePatchLocaleEnum? get locale => _$this._locale;
  set locale(PreferencePatchLocaleEnum? locale) => _$this._locale = locale;

  PreferencePatchDisplayDensityEnum? _displayDensity;
  PreferencePatchDisplayDensityEnum? get displayDensity =>
      _$this._displayDensity;
  set displayDensity(PreferencePatchDisplayDensityEnum? displayDensity) =>
      _$this._displayDensity = displayDensity;

  PreferencePatchColourSchemeEnum? _colourScheme;
  PreferencePatchColourSchemeEnum? get colourScheme => _$this._colourScheme;
  set colourScheme(PreferencePatchColourSchemeEnum? colourScheme) =>
      _$this._colourScheme = colourScheme;

  String? _lastBodyId;
  String? get lastBodyId => _$this._lastBodyId;
  set lastBodyId(String? lastBodyId) => _$this._lastBodyId = lastBodyId;

  PreferencePatchBuilder() {
    PreferencePatch._defaults(this);
  }

  PreferencePatchBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _locale = $v.locale;
      _displayDensity = $v.displayDensity;
      _colourScheme = $v.colourScheme;
      _lastBodyId = $v.lastBodyId;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(PreferencePatch other) {
    _$v = other as _$PreferencePatch;
  }

  @override
  void update(void Function(PreferencePatchBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  PreferencePatch build() => _build();

  _$PreferencePatch _build() {
    final _$result = _$v ??
        _$PreferencePatch._(
          locale: locale,
          displayDensity: displayDensity,
          colourScheme: colourScheme,
          lastBodyId: lastBodyId,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
