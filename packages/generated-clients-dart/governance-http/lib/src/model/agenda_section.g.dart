// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agenda_section.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const AgendaSectionPublicationClassEnum
    _$agendaSectionPublicationClassEnum_public =
    const AgendaSectionPublicationClassEnum._('public');
const AgendaSectionPublicationClassEnum
    _$agendaSectionPublicationClassEnum_nonPublic =
    const AgendaSectionPublicationClassEnum._('nonPublic');
const AgendaSectionPublicationClassEnum
    _$agendaSectionPublicationClassEnum_unknownDefaultOpenApi =
    const AgendaSectionPublicationClassEnum._('unknownDefaultOpenApi');

AgendaSectionPublicationClassEnum _$agendaSectionPublicationClassEnumValueOf(
    String name) {
  switch (name) {
    case 'public':
      return _$agendaSectionPublicationClassEnum_public;
    case 'nonPublic':
      return _$agendaSectionPublicationClassEnum_nonPublic;
    case 'unknownDefaultOpenApi':
      return _$agendaSectionPublicationClassEnum_unknownDefaultOpenApi;
    default:
      return _$agendaSectionPublicationClassEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<AgendaSectionPublicationClassEnum>
    _$agendaSectionPublicationClassEnumValues = BuiltSet<
        AgendaSectionPublicationClassEnum>(const <AgendaSectionPublicationClassEnum>[
  _$agendaSectionPublicationClassEnum_public,
  _$agendaSectionPublicationClassEnum_nonPublic,
  _$agendaSectionPublicationClassEnum_unknownDefaultOpenApi,
]);

Serializer<AgendaSectionPublicationClassEnum>
    _$agendaSectionPublicationClassEnumSerializer =
    _$AgendaSectionPublicationClassEnumSerializer();

class _$AgendaSectionPublicationClassEnumSerializer
    implements PrimitiveSerializer<AgendaSectionPublicationClassEnum> {
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
  final Iterable<Type> types = const <Type>[AgendaSectionPublicationClassEnum];
  @override
  final String wireName = 'AgendaSectionPublicationClassEnum';

  @override
  Object serialize(
          Serializers serializers, AgendaSectionPublicationClassEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  AgendaSectionPublicationClassEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      AgendaSectionPublicationClassEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$AgendaSection extends AgendaSection {
  @override
  final String sectionId;
  @override
  final String meetingId;
  @override
  final int position;
  @override
  final String title;
  @override
  final AgendaSectionPublicationClassEnum publicationClass;

  factory _$AgendaSection([void Function(AgendaSectionBuilder)? updates]) =>
      (AgendaSectionBuilder()..update(updates))._build();

  _$AgendaSection._(
      {required this.sectionId,
      required this.meetingId,
      required this.position,
      required this.title,
      required this.publicationClass})
      : super._();
  @override
  AgendaSection rebuild(void Function(AgendaSectionBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AgendaSectionBuilder toBuilder() => AgendaSectionBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AgendaSection &&
        sectionId == other.sectionId &&
        meetingId == other.meetingId &&
        position == other.position &&
        title == other.title &&
        publicationClass == other.publicationClass;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, sectionId.hashCode);
    _$hash = $jc(_$hash, meetingId.hashCode);
    _$hash = $jc(_$hash, position.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, publicationClass.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AgendaSection')
          ..add('sectionId', sectionId)
          ..add('meetingId', meetingId)
          ..add('position', position)
          ..add('title', title)
          ..add('publicationClass', publicationClass))
        .toString();
  }
}

class AgendaSectionBuilder
    implements Builder<AgendaSection, AgendaSectionBuilder> {
  _$AgendaSection? _$v;

  String? _sectionId;
  String? get sectionId => _$this._sectionId;
  set sectionId(String? sectionId) => _$this._sectionId = sectionId;

  String? _meetingId;
  String? get meetingId => _$this._meetingId;
  set meetingId(String? meetingId) => _$this._meetingId = meetingId;

  int? _position;
  int? get position => _$this._position;
  set position(int? position) => _$this._position = position;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  AgendaSectionPublicationClassEnum? _publicationClass;
  AgendaSectionPublicationClassEnum? get publicationClass =>
      _$this._publicationClass;
  set publicationClass(AgendaSectionPublicationClassEnum? publicationClass) =>
      _$this._publicationClass = publicationClass;

  AgendaSectionBuilder() {
    AgendaSection._defaults(this);
  }

  AgendaSectionBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _sectionId = $v.sectionId;
      _meetingId = $v.meetingId;
      _position = $v.position;
      _title = $v.title;
      _publicationClass = $v.publicationClass;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AgendaSection other) {
    _$v = other as _$AgendaSection;
  }

  @override
  void update(void Function(AgendaSectionBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AgendaSection build() => _build();

  _$AgendaSection _build() {
    final _$result = _$v ??
        _$AgendaSection._(
          sectionId: BuiltValueNullFieldError.checkNotNull(
              sectionId, r'AgendaSection', 'sectionId'),
          meetingId: BuiltValueNullFieldError.checkNotNull(
              meetingId, r'AgendaSection', 'meetingId'),
          position: BuiltValueNullFieldError.checkNotNull(
              position, r'AgendaSection', 'position'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'AgendaSection', 'title'),
          publicationClass: BuiltValueNullFieldError.checkNotNull(
              publicationClass, r'AgendaSection', 'publicationClass'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
