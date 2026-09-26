// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agenda_item_create.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const AgendaItemCreateKindEnum _$agendaItemCreateKindEnum_report =
    const AgendaItemCreateKindEnum._('report');
const AgendaItemCreateKindEnum _$agendaItemCreateKindEnum_motion =
    const AgendaItemCreateKindEnum._('motion');
const AgendaItemCreateKindEnum
    _$agendaItemCreateKindEnum_previousProtocolApproval =
    const AgendaItemCreateKindEnum._('previousProtocolApproval');
const AgendaItemCreateKindEnum _$agendaItemCreateKindEnum_election =
    const AgendaItemCreateKindEnum._('election');
const AgendaItemCreateKindEnum _$agendaItemCreateKindEnum_misc =
    const AgendaItemCreateKindEnum._('misc');
const AgendaItemCreateKindEnum
    _$agendaItemCreateKindEnum_unknownDefaultOpenApi =
    const AgendaItemCreateKindEnum._('unknownDefaultOpenApi');

AgendaItemCreateKindEnum _$agendaItemCreateKindEnumValueOf(String name) {
  switch (name) {
    case 'report':
      return _$agendaItemCreateKindEnum_report;
    case 'motion':
      return _$agendaItemCreateKindEnum_motion;
    case 'previousProtocolApproval':
      return _$agendaItemCreateKindEnum_previousProtocolApproval;
    case 'election':
      return _$agendaItemCreateKindEnum_election;
    case 'misc':
      return _$agendaItemCreateKindEnum_misc;
    case 'unknownDefaultOpenApi':
      return _$agendaItemCreateKindEnum_unknownDefaultOpenApi;
    default:
      return _$agendaItemCreateKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<AgendaItemCreateKindEnum> _$agendaItemCreateKindEnumValues =
    BuiltSet<AgendaItemCreateKindEnum>(const <AgendaItemCreateKindEnum>[
  _$agendaItemCreateKindEnum_report,
  _$agendaItemCreateKindEnum_motion,
  _$agendaItemCreateKindEnum_previousProtocolApproval,
  _$agendaItemCreateKindEnum_election,
  _$agendaItemCreateKindEnum_misc,
  _$agendaItemCreateKindEnum_unknownDefaultOpenApi,
]);

const AgendaItemCreateOwnPublicationClassEnum
    _$agendaItemCreateOwnPublicationClassEnum_public =
    const AgendaItemCreateOwnPublicationClassEnum._('public');
const AgendaItemCreateOwnPublicationClassEnum
    _$agendaItemCreateOwnPublicationClassEnum_nonPublic =
    const AgendaItemCreateOwnPublicationClassEnum._('nonPublic');
const AgendaItemCreateOwnPublicationClassEnum
    _$agendaItemCreateOwnPublicationClassEnum_unknownDefaultOpenApi =
    const AgendaItemCreateOwnPublicationClassEnum._('unknownDefaultOpenApi');

AgendaItemCreateOwnPublicationClassEnum
    _$agendaItemCreateOwnPublicationClassEnumValueOf(String name) {
  switch (name) {
    case 'public':
      return _$agendaItemCreateOwnPublicationClassEnum_public;
    case 'nonPublic':
      return _$agendaItemCreateOwnPublicationClassEnum_nonPublic;
    case 'unknownDefaultOpenApi':
      return _$agendaItemCreateOwnPublicationClassEnum_unknownDefaultOpenApi;
    default:
      return _$agendaItemCreateOwnPublicationClassEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<AgendaItemCreateOwnPublicationClassEnum>
    _$agendaItemCreateOwnPublicationClassEnumValues = BuiltSet<
        AgendaItemCreateOwnPublicationClassEnum>(const <AgendaItemCreateOwnPublicationClassEnum>[
  _$agendaItemCreateOwnPublicationClassEnum_public,
  _$agendaItemCreateOwnPublicationClassEnum_nonPublic,
  _$agendaItemCreateOwnPublicationClassEnum_unknownDefaultOpenApi,
]);

Serializer<AgendaItemCreateKindEnum> _$agendaItemCreateKindEnumSerializer =
    _$AgendaItemCreateKindEnumSerializer();
Serializer<AgendaItemCreateOwnPublicationClassEnum>
    _$agendaItemCreateOwnPublicationClassEnumSerializer =
    _$AgendaItemCreateOwnPublicationClassEnumSerializer();

class _$AgendaItemCreateKindEnumSerializer
    implements PrimitiveSerializer<AgendaItemCreateKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'report': 'report',
    'motion': 'motion',
    'previousProtocolApproval': 'previous_protocol_approval',
    'election': 'election',
    'misc': 'misc',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'report': 'report',
    'motion': 'motion',
    'previous_protocol_approval': 'previousProtocolApproval',
    'election': 'election',
    'misc': 'misc',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[AgendaItemCreateKindEnum];
  @override
  final String wireName = 'AgendaItemCreateKindEnum';

  @override
  Object serialize(Serializers serializers, AgendaItemCreateKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  AgendaItemCreateKindEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      AgendaItemCreateKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$AgendaItemCreateOwnPublicationClassEnumSerializer
    implements PrimitiveSerializer<AgendaItemCreateOwnPublicationClassEnum> {
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
    AgendaItemCreateOwnPublicationClassEnum
  ];
  @override
  final String wireName = 'AgendaItemCreateOwnPublicationClassEnum';

  @override
  Object serialize(Serializers serializers,
          AgendaItemCreateOwnPublicationClassEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  AgendaItemCreateOwnPublicationClassEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      AgendaItemCreateOwnPublicationClassEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$AgendaItemCreate extends AgendaItemCreate {
  @override
  final String? sectionId;
  @override
  final int? position;
  @override
  final String title;
  @override
  final String? description;
  @override
  final AgendaItemCreateKindEnum kind;
  @override
  final AgendaItemCreateOwnPublicationClassEnum? ownPublicationClass;

  factory _$AgendaItemCreate(
          [void Function(AgendaItemCreateBuilder)? updates]) =>
      (AgendaItemCreateBuilder()..update(updates))._build();

  _$AgendaItemCreate._(
      {this.sectionId,
      this.position,
      required this.title,
      this.description,
      required this.kind,
      this.ownPublicationClass})
      : super._();
  @override
  AgendaItemCreate rebuild(void Function(AgendaItemCreateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AgendaItemCreateBuilder toBuilder() =>
      AgendaItemCreateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AgendaItemCreate &&
        sectionId == other.sectionId &&
        position == other.position &&
        title == other.title &&
        description == other.description &&
        kind == other.kind &&
        ownPublicationClass == other.ownPublicationClass;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, sectionId.hashCode);
    _$hash = $jc(_$hash, position.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, description.hashCode);
    _$hash = $jc(_$hash, kind.hashCode);
    _$hash = $jc(_$hash, ownPublicationClass.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AgendaItemCreate')
          ..add('sectionId', sectionId)
          ..add('position', position)
          ..add('title', title)
          ..add('description', description)
          ..add('kind', kind)
          ..add('ownPublicationClass', ownPublicationClass))
        .toString();
  }
}

class AgendaItemCreateBuilder
    implements Builder<AgendaItemCreate, AgendaItemCreateBuilder> {
  _$AgendaItemCreate? _$v;

  String? _sectionId;
  String? get sectionId => _$this._sectionId;
  set sectionId(String? sectionId) => _$this._sectionId = sectionId;

  int? _position;
  int? get position => _$this._position;
  set position(int? position) => _$this._position = position;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  String? _description;
  String? get description => _$this._description;
  set description(String? description) => _$this._description = description;

  AgendaItemCreateKindEnum? _kind;
  AgendaItemCreateKindEnum? get kind => _$this._kind;
  set kind(AgendaItemCreateKindEnum? kind) => _$this._kind = kind;

  AgendaItemCreateOwnPublicationClassEnum? _ownPublicationClass;
  AgendaItemCreateOwnPublicationClassEnum? get ownPublicationClass =>
      _$this._ownPublicationClass;
  set ownPublicationClass(
          AgendaItemCreateOwnPublicationClassEnum? ownPublicationClass) =>
      _$this._ownPublicationClass = ownPublicationClass;

  AgendaItemCreateBuilder() {
    AgendaItemCreate._defaults(this);
  }

  AgendaItemCreateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _sectionId = $v.sectionId;
      _position = $v.position;
      _title = $v.title;
      _description = $v.description;
      _kind = $v.kind;
      _ownPublicationClass = $v.ownPublicationClass;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AgendaItemCreate other) {
    _$v = other as _$AgendaItemCreate;
  }

  @override
  void update(void Function(AgendaItemCreateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AgendaItemCreate build() => _build();

  _$AgendaItemCreate _build() {
    final _$result = _$v ??
        _$AgendaItemCreate._(
          sectionId: sectionId,
          position: position,
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'AgendaItemCreate', 'title'),
          description: description,
          kind: BuiltValueNullFieldError.checkNotNull(
              kind, r'AgendaItemCreate', 'kind'),
          ownPublicationClass: ownPublicationClass,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
