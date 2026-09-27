// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agenda_item_update.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const AgendaItemUpdateKindEnum _$agendaItemUpdateKindEnum_report =
    const AgendaItemUpdateKindEnum._('report');
const AgendaItemUpdateKindEnum _$agendaItemUpdateKindEnum_motion =
    const AgendaItemUpdateKindEnum._('motion');
const AgendaItemUpdateKindEnum
    _$agendaItemUpdateKindEnum_previousProtocolApproval =
    const AgendaItemUpdateKindEnum._('previousProtocolApproval');
const AgendaItemUpdateKindEnum _$agendaItemUpdateKindEnum_election =
    const AgendaItemUpdateKindEnum._('election');
const AgendaItemUpdateKindEnum _$agendaItemUpdateKindEnum_misc =
    const AgendaItemUpdateKindEnum._('misc');
const AgendaItemUpdateKindEnum
    _$agendaItemUpdateKindEnum_unknownDefaultOpenApi =
    const AgendaItemUpdateKindEnum._('unknownDefaultOpenApi');

AgendaItemUpdateKindEnum _$agendaItemUpdateKindEnumValueOf(String name) {
  switch (name) {
    case 'report':
      return _$agendaItemUpdateKindEnum_report;
    case 'motion':
      return _$agendaItemUpdateKindEnum_motion;
    case 'previousProtocolApproval':
      return _$agendaItemUpdateKindEnum_previousProtocolApproval;
    case 'election':
      return _$agendaItemUpdateKindEnum_election;
    case 'misc':
      return _$agendaItemUpdateKindEnum_misc;
    case 'unknownDefaultOpenApi':
      return _$agendaItemUpdateKindEnum_unknownDefaultOpenApi;
    default:
      return _$agendaItemUpdateKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<AgendaItemUpdateKindEnum> _$agendaItemUpdateKindEnumValues =
    BuiltSet<AgendaItemUpdateKindEnum>(const <AgendaItemUpdateKindEnum>[
  _$agendaItemUpdateKindEnum_report,
  _$agendaItemUpdateKindEnum_motion,
  _$agendaItemUpdateKindEnum_previousProtocolApproval,
  _$agendaItemUpdateKindEnum_election,
  _$agendaItemUpdateKindEnum_misc,
  _$agendaItemUpdateKindEnum_unknownDefaultOpenApi,
]);

const AgendaItemUpdateOwnPublicationClassEnum
    _$agendaItemUpdateOwnPublicationClassEnum_public =
    const AgendaItemUpdateOwnPublicationClassEnum._('public');
const AgendaItemUpdateOwnPublicationClassEnum
    _$agendaItemUpdateOwnPublicationClassEnum_nonPublic =
    const AgendaItemUpdateOwnPublicationClassEnum._('nonPublic');
const AgendaItemUpdateOwnPublicationClassEnum
    _$agendaItemUpdateOwnPublicationClassEnum_unknownDefaultOpenApi =
    const AgendaItemUpdateOwnPublicationClassEnum._('unknownDefaultOpenApi');

AgendaItemUpdateOwnPublicationClassEnum
    _$agendaItemUpdateOwnPublicationClassEnumValueOf(String name) {
  switch (name) {
    case 'public':
      return _$agendaItemUpdateOwnPublicationClassEnum_public;
    case 'nonPublic':
      return _$agendaItemUpdateOwnPublicationClassEnum_nonPublic;
    case 'unknownDefaultOpenApi':
      return _$agendaItemUpdateOwnPublicationClassEnum_unknownDefaultOpenApi;
    default:
      return _$agendaItemUpdateOwnPublicationClassEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<AgendaItemUpdateOwnPublicationClassEnum>
    _$agendaItemUpdateOwnPublicationClassEnumValues = BuiltSet<
        AgendaItemUpdateOwnPublicationClassEnum>(const <AgendaItemUpdateOwnPublicationClassEnum>[
  _$agendaItemUpdateOwnPublicationClassEnum_public,
  _$agendaItemUpdateOwnPublicationClassEnum_nonPublic,
  _$agendaItemUpdateOwnPublicationClassEnum_unknownDefaultOpenApi,
]);

Serializer<AgendaItemUpdateKindEnum> _$agendaItemUpdateKindEnumSerializer =
    _$AgendaItemUpdateKindEnumSerializer();
Serializer<AgendaItemUpdateOwnPublicationClassEnum>
    _$agendaItemUpdateOwnPublicationClassEnumSerializer =
    _$AgendaItemUpdateOwnPublicationClassEnumSerializer();

class _$AgendaItemUpdateKindEnumSerializer
    implements PrimitiveSerializer<AgendaItemUpdateKindEnum> {
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
  final Iterable<Type> types = const <Type>[AgendaItemUpdateKindEnum];
  @override
  final String wireName = 'AgendaItemUpdateKindEnum';

  @override
  Object serialize(Serializers serializers, AgendaItemUpdateKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  AgendaItemUpdateKindEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      AgendaItemUpdateKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$AgendaItemUpdateOwnPublicationClassEnumSerializer
    implements PrimitiveSerializer<AgendaItemUpdateOwnPublicationClassEnum> {
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
    AgendaItemUpdateOwnPublicationClassEnum
  ];
  @override
  final String wireName = 'AgendaItemUpdateOwnPublicationClassEnum';

  @override
  Object serialize(Serializers serializers,
          AgendaItemUpdateOwnPublicationClassEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  AgendaItemUpdateOwnPublicationClassEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      AgendaItemUpdateOwnPublicationClassEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$AgendaItemUpdate extends AgendaItemUpdate {
  @override
  final String? sectionId;
  @override
  final int? position;
  @override
  final String? title;
  @override
  final String? description;
  @override
  final AgendaItemUpdateKindEnum? kind;
  @override
  final AgendaItemUpdateOwnPublicationClassEnum? ownPublicationClass;

  factory _$AgendaItemUpdate(
          [void Function(AgendaItemUpdateBuilder)? updates]) =>
      (AgendaItemUpdateBuilder()..update(updates))._build();

  _$AgendaItemUpdate._(
      {this.sectionId,
      this.position,
      this.title,
      this.description,
      this.kind,
      this.ownPublicationClass})
      : super._();
  @override
  AgendaItemUpdate rebuild(void Function(AgendaItemUpdateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AgendaItemUpdateBuilder toBuilder() =>
      AgendaItemUpdateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AgendaItemUpdate &&
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
    return (newBuiltValueToStringHelper(r'AgendaItemUpdate')
          ..add('sectionId', sectionId)
          ..add('position', position)
          ..add('title', title)
          ..add('description', description)
          ..add('kind', kind)
          ..add('ownPublicationClass', ownPublicationClass))
        .toString();
  }
}

class AgendaItemUpdateBuilder
    implements Builder<AgendaItemUpdate, AgendaItemUpdateBuilder> {
  _$AgendaItemUpdate? _$v;

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

  AgendaItemUpdateKindEnum? _kind;
  AgendaItemUpdateKindEnum? get kind => _$this._kind;
  set kind(AgendaItemUpdateKindEnum? kind) => _$this._kind = kind;

  AgendaItemUpdateOwnPublicationClassEnum? _ownPublicationClass;
  AgendaItemUpdateOwnPublicationClassEnum? get ownPublicationClass =>
      _$this._ownPublicationClass;
  set ownPublicationClass(
          AgendaItemUpdateOwnPublicationClassEnum? ownPublicationClass) =>
      _$this._ownPublicationClass = ownPublicationClass;

  AgendaItemUpdateBuilder() {
    AgendaItemUpdate._defaults(this);
  }

  AgendaItemUpdateBuilder get _$this {
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
  void replace(AgendaItemUpdate other) {
    _$v = other as _$AgendaItemUpdate;
  }

  @override
  void update(void Function(AgendaItemUpdateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AgendaItemUpdate build() => _build();

  _$AgendaItemUpdate _build() {
    final _$result = _$v ??
        _$AgendaItemUpdate._(
          sectionId: sectionId,
          position: position,
          title: title,
          description: description,
          kind: kind,
          ownPublicationClass: ownPublicationClass,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
