// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agenda_section_create.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const AgendaSectionCreatePublicationClassEnum
    _$agendaSectionCreatePublicationClassEnum_public =
    const AgendaSectionCreatePublicationClassEnum._('public');
const AgendaSectionCreatePublicationClassEnum
    _$agendaSectionCreatePublicationClassEnum_nonPublic =
    const AgendaSectionCreatePublicationClassEnum._('nonPublic');
const AgendaSectionCreatePublicationClassEnum
    _$agendaSectionCreatePublicationClassEnum_unknownDefaultOpenApi =
    const AgendaSectionCreatePublicationClassEnum._('unknownDefaultOpenApi');

AgendaSectionCreatePublicationClassEnum
    _$agendaSectionCreatePublicationClassEnumValueOf(String name) {
  switch (name) {
    case 'public':
      return _$agendaSectionCreatePublicationClassEnum_public;
    case 'nonPublic':
      return _$agendaSectionCreatePublicationClassEnum_nonPublic;
    case 'unknownDefaultOpenApi':
      return _$agendaSectionCreatePublicationClassEnum_unknownDefaultOpenApi;
    default:
      return _$agendaSectionCreatePublicationClassEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<AgendaSectionCreatePublicationClassEnum>
    _$agendaSectionCreatePublicationClassEnumValues = BuiltSet<
        AgendaSectionCreatePublicationClassEnum>(const <AgendaSectionCreatePublicationClassEnum>[
  _$agendaSectionCreatePublicationClassEnum_public,
  _$agendaSectionCreatePublicationClassEnum_nonPublic,
  _$agendaSectionCreatePublicationClassEnum_unknownDefaultOpenApi,
]);

Serializer<AgendaSectionCreatePublicationClassEnum>
    _$agendaSectionCreatePublicationClassEnumSerializer =
    _$AgendaSectionCreatePublicationClassEnumSerializer();

class _$AgendaSectionCreatePublicationClassEnumSerializer
    implements PrimitiveSerializer<AgendaSectionCreatePublicationClassEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'public': 'public',
    'nonPublic': 'non_public',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'public': 'public',
    'non_public': 'nonPublic',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[
    AgendaSectionCreatePublicationClassEnum
  ];
  @override
  final String wireName = 'AgendaSectionCreatePublicationClassEnum';

  @override
  Object serialize(Serializers serializers,
          AgendaSectionCreatePublicationClassEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  AgendaSectionCreatePublicationClassEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      AgendaSectionCreatePublicationClassEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$AgendaSectionCreate extends AgendaSectionCreate {
  @override
  final int position;
  @override
  final String title;
  @override
  final AgendaSectionCreatePublicationClassEnum publicationClass;

  factory _$AgendaSectionCreate(
          [void Function(AgendaSectionCreateBuilder)? updates]) =>
      (AgendaSectionCreateBuilder()..update(updates))._build();

  _$AgendaSectionCreate._(
      {required this.position,
      required this.title,
      required this.publicationClass})
      : super._();
  @override
  AgendaSectionCreate rebuild(
          void Function(AgendaSectionCreateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AgendaSectionCreateBuilder toBuilder() =>
      AgendaSectionCreateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AgendaSectionCreate &&
        position == other.position &&
        title == other.title &&
        publicationClass == other.publicationClass;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, position.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, publicationClass.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AgendaSectionCreate')
          ..add('position', position)
          ..add('title', title)
          ..add('publicationClass', publicationClass))
        .toString();
  }
}

class AgendaSectionCreateBuilder
    implements Builder<AgendaSectionCreate, AgendaSectionCreateBuilder> {
  _$AgendaSectionCreate? _$v;

  int? _position;
  int? get position => _$this._position;
  set position(int? position) => _$this._position = position;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  AgendaSectionCreatePublicationClassEnum? _publicationClass;
  AgendaSectionCreatePublicationClassEnum? get publicationClass =>
      _$this._publicationClass;
  set publicationClass(
          AgendaSectionCreatePublicationClassEnum? publicationClass) =>
      _$this._publicationClass = publicationClass;

  AgendaSectionCreateBuilder() {
    AgendaSectionCreate._defaults(this);
  }

  AgendaSectionCreateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _position = $v.position;
      _title = $v.title;
      _publicationClass = $v.publicationClass;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AgendaSectionCreate other) {
    _$v = other as _$AgendaSectionCreate;
  }

  @override
  void update(void Function(AgendaSectionCreateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AgendaSectionCreate build() => _build();

  _$AgendaSectionCreate _build() {
    final _$result = _$v ??
        _$AgendaSectionCreate._(
          position: BuiltValueNullFieldError.checkNotNull(
              position, r'AgendaSectionCreate', 'position'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'AgendaSectionCreate', 'title'),
          publicationClass: BuiltValueNullFieldError.checkNotNull(
              publicationClass, r'AgendaSectionCreate', 'publicationClass'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
