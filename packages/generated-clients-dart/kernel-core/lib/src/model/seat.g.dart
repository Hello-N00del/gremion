// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'seat.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const SeatSeatKindEnum _$seatSeatKindEnum_votingMember =
    const SeatSeatKindEnum._('votingMember');
const SeatSeatKindEnum _$seatSeatKindEnum_office =
    const SeatSeatKindEnum._('office');
const SeatSeatKindEnum _$seatSeatKindEnum_advisory =
    const SeatSeatKindEnum._('advisory');
const SeatSeatKindEnum _$seatSeatKindEnum_unknownDefaultOpenApi =
    const SeatSeatKindEnum._('unknownDefaultOpenApi');

SeatSeatKindEnum _$seatSeatKindEnumValueOf(String name) {
  switch (name) {
    case 'votingMember':
      return _$seatSeatKindEnum_votingMember;
    case 'office':
      return _$seatSeatKindEnum_office;
    case 'advisory':
      return _$seatSeatKindEnum_advisory;
    case 'unknownDefaultOpenApi':
      return _$seatSeatKindEnum_unknownDefaultOpenApi;
    default:
      return _$seatSeatKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<SeatSeatKindEnum> _$seatSeatKindEnumValues =
    BuiltSet<SeatSeatKindEnum>(const <SeatSeatKindEnum>[
  _$seatSeatKindEnum_votingMember,
  _$seatSeatKindEnum_office,
  _$seatSeatKindEnum_advisory,
  _$seatSeatKindEnum_unknownDefaultOpenApi,
]);

const SeatFillModeEnum _$seatFillModeEnum_directElection =
    const SeatFillModeEnum._('directElection');
const SeatFillModeEnum _$seatFillModeEnum_delegation =
    const SeatFillModeEnum._('delegation');
const SeatFillModeEnum _$seatFillModeEnum_appointment =
    const SeatFillModeEnum._('appointment');
const SeatFillModeEnum _$seatFillModeEnum_unknownDefaultOpenApi =
    const SeatFillModeEnum._('unknownDefaultOpenApi');

SeatFillModeEnum _$seatFillModeEnumValueOf(String name) {
  switch (name) {
    case 'directElection':
      return _$seatFillModeEnum_directElection;
    case 'delegation':
      return _$seatFillModeEnum_delegation;
    case 'appointment':
      return _$seatFillModeEnum_appointment;
    case 'unknownDefaultOpenApi':
      return _$seatFillModeEnum_unknownDefaultOpenApi;
    default:
      return _$seatFillModeEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<SeatFillModeEnum> _$seatFillModeEnumValues =
    BuiltSet<SeatFillModeEnum>(const <SeatFillModeEnum>[
  _$seatFillModeEnum_directElection,
  _$seatFillModeEnum_delegation,
  _$seatFillModeEnum_appointment,
  _$seatFillModeEnum_unknownDefaultOpenApi,
]);

const SeatHolderCardinalityEnum _$seatHolderCardinalityEnum_single =
    const SeatHolderCardinalityEnum._('single');
const SeatHolderCardinalityEnum _$seatHolderCardinalityEnum_multiple =
    const SeatHolderCardinalityEnum._('multiple');
const SeatHolderCardinalityEnum
    _$seatHolderCardinalityEnum_unknownDefaultOpenApi =
    const SeatHolderCardinalityEnum._('unknownDefaultOpenApi');

SeatHolderCardinalityEnum _$seatHolderCardinalityEnumValueOf(String name) {
  switch (name) {
    case 'single':
      return _$seatHolderCardinalityEnum_single;
    case 'multiple':
      return _$seatHolderCardinalityEnum_multiple;
    case 'unknownDefaultOpenApi':
      return _$seatHolderCardinalityEnum_unknownDefaultOpenApi;
    default:
      return _$seatHolderCardinalityEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<SeatHolderCardinalityEnum> _$seatHolderCardinalityEnumValues =
    BuiltSet<SeatHolderCardinalityEnum>(const <SeatHolderCardinalityEnum>[
  _$seatHolderCardinalityEnum_single,
  _$seatHolderCardinalityEnum_multiple,
  _$seatHolderCardinalityEnum_unknownDefaultOpenApi,
]);

const SeatStateEnum _$seatStateEnum_active = const SeatStateEnum._('active');
const SeatStateEnum _$seatStateEnum_retired = const SeatStateEnum._('retired');
const SeatStateEnum _$seatStateEnum_unknownDefaultOpenApi =
    const SeatStateEnum._('unknownDefaultOpenApi');

SeatStateEnum _$seatStateEnumValueOf(String name) {
  switch (name) {
    case 'active':
      return _$seatStateEnum_active;
    case 'retired':
      return _$seatStateEnum_retired;
    case 'unknownDefaultOpenApi':
      return _$seatStateEnum_unknownDefaultOpenApi;
    default:
      return _$seatStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<SeatStateEnum> _$seatStateEnumValues =
    BuiltSet<SeatStateEnum>(const <SeatStateEnum>[
  _$seatStateEnum_active,
  _$seatStateEnum_retired,
  _$seatStateEnum_unknownDefaultOpenApi,
]);

Serializer<SeatSeatKindEnum> _$seatSeatKindEnumSerializer =
    _$SeatSeatKindEnumSerializer();
Serializer<SeatFillModeEnum> _$seatFillModeEnumSerializer =
    _$SeatFillModeEnumSerializer();
Serializer<SeatHolderCardinalityEnum> _$seatHolderCardinalityEnumSerializer =
    _$SeatHolderCardinalityEnumSerializer();
Serializer<SeatStateEnum> _$seatStateEnumSerializer =
    _$SeatStateEnumSerializer();

class _$SeatSeatKindEnumSerializer
    implements PrimitiveSerializer<SeatSeatKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'votingMember': 'voting_member',
    'office': 'office',
    'advisory': 'advisory',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'voting_member': 'votingMember',
    'office': 'office',
    'advisory': 'advisory',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[SeatSeatKindEnum];
  @override
  final String wireName = 'SeatSeatKindEnum';

  @override
  Object serialize(Serializers serializers, SeatSeatKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  SeatSeatKindEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      SeatSeatKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$SeatFillModeEnumSerializer
    implements PrimitiveSerializer<SeatFillModeEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'directElection': 'direct_election',
    'delegation': 'delegation',
    'appointment': 'appointment',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'direct_election': 'directElection',
    'delegation': 'delegation',
    'appointment': 'appointment',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[SeatFillModeEnum];
  @override
  final String wireName = 'SeatFillModeEnum';

  @override
  Object serialize(Serializers serializers, SeatFillModeEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  SeatFillModeEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      SeatFillModeEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$SeatHolderCardinalityEnumSerializer
    implements PrimitiveSerializer<SeatHolderCardinalityEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'single': 'single',
    'multiple': 'multiple',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'single': 'single',
    'multiple': 'multiple',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[SeatHolderCardinalityEnum];
  @override
  final String wireName = 'SeatHolderCardinalityEnum';

  @override
  Object serialize(Serializers serializers, SeatHolderCardinalityEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  SeatHolderCardinalityEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      SeatHolderCardinalityEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$SeatStateEnumSerializer implements PrimitiveSerializer<SeatStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'active': 'active',
    'retired': 'retired',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'active': 'active',
    'retired': 'retired',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[SeatStateEnum];
  @override
  final String wireName = 'SeatStateEnum';

  @override
  Object serialize(Serializers serializers, SeatStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  SeatStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      SeatStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Seat extends Seat {
  @override
  final String seatId;
  @override
  final String bodyId;
  @override
  final String? orgUnitId;
  @override
  final String title;
  @override
  final SeatSeatKindEnum seatKind;
  @override
  final SeatFillModeEnum fillMode;
  @override
  final SeatHolderCardinalityEnum holderCardinality;
  @override
  final bool voting;
  @override
  final SeatStateEnum state;
  @override
  final BuiltList<SeatHolder> holders;

  factory _$Seat([void Function(SeatBuilder)? updates]) =>
      (SeatBuilder()..update(updates))._build();

  _$Seat._(
      {required this.seatId,
      required this.bodyId,
      this.orgUnitId,
      required this.title,
      required this.seatKind,
      required this.fillMode,
      required this.holderCardinality,
      required this.voting,
      required this.state,
      required this.holders})
      : super._();
  @override
  Seat rebuild(void Function(SeatBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  SeatBuilder toBuilder() => SeatBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Seat &&
        seatId == other.seatId &&
        bodyId == other.bodyId &&
        orgUnitId == other.orgUnitId &&
        title == other.title &&
        seatKind == other.seatKind &&
        fillMode == other.fillMode &&
        holderCardinality == other.holderCardinality &&
        voting == other.voting &&
        state == other.state &&
        holders == other.holders;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, seatId.hashCode);
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, seatKind.hashCode);
    _$hash = $jc(_$hash, fillMode.hashCode);
    _$hash = $jc(_$hash, holderCardinality.hashCode);
    _$hash = $jc(_$hash, voting.hashCode);
    _$hash = $jc(_$hash, state.hashCode);
    _$hash = $jc(_$hash, holders.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Seat')
          ..add('seatId', seatId)
          ..add('bodyId', bodyId)
          ..add('orgUnitId', orgUnitId)
          ..add('title', title)
          ..add('seatKind', seatKind)
          ..add('fillMode', fillMode)
          ..add('holderCardinality', holderCardinality)
          ..add('voting', voting)
          ..add('state', state)
          ..add('holders', holders))
        .toString();
  }
}

class SeatBuilder implements Builder<Seat, SeatBuilder> {
  _$Seat? _$v;

  String? _seatId;
  String? get seatId => _$this._seatId;
  set seatId(String? seatId) => _$this._seatId = seatId;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  SeatSeatKindEnum? _seatKind;
  SeatSeatKindEnum? get seatKind => _$this._seatKind;
  set seatKind(SeatSeatKindEnum? seatKind) => _$this._seatKind = seatKind;

  SeatFillModeEnum? _fillMode;
  SeatFillModeEnum? get fillMode => _$this._fillMode;
  set fillMode(SeatFillModeEnum? fillMode) => _$this._fillMode = fillMode;

  SeatHolderCardinalityEnum? _holderCardinality;
  SeatHolderCardinalityEnum? get holderCardinality => _$this._holderCardinality;
  set holderCardinality(SeatHolderCardinalityEnum? holderCardinality) =>
      _$this._holderCardinality = holderCardinality;

  bool? _voting;
  bool? get voting => _$this._voting;
  set voting(bool? voting) => _$this._voting = voting;

  SeatStateEnum? _state;
  SeatStateEnum? get state => _$this._state;
  set state(SeatStateEnum? state) => _$this._state = state;

  ListBuilder<SeatHolder>? _holders;
  ListBuilder<SeatHolder> get holders =>
      _$this._holders ??= ListBuilder<SeatHolder>();
  set holders(ListBuilder<SeatHolder>? holders) => _$this._holders = holders;

  SeatBuilder() {
    Seat._defaults(this);
  }

  SeatBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _seatId = $v.seatId;
      _bodyId = $v.bodyId;
      _orgUnitId = $v.orgUnitId;
      _title = $v.title;
      _seatKind = $v.seatKind;
      _fillMode = $v.fillMode;
      _holderCardinality = $v.holderCardinality;
      _voting = $v.voting;
      _state = $v.state;
      _holders = $v.holders.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Seat other) {
    _$v = other as _$Seat;
  }

  @override
  void update(void Function(SeatBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Seat build() => _build();

  _$Seat _build() {
    _$Seat _$result;
    try {
      _$result = _$v ??
          _$Seat._(
            seatId: BuiltValueNullFieldError.checkNotNull(
                seatId, r'Seat', 'seatId'),
            bodyId: BuiltValueNullFieldError.checkNotNull(
                bodyId, r'Seat', 'bodyId'),
            orgUnitId: orgUnitId,
            title:
                BuiltValueNullFieldError.checkNotNull(title, r'Seat', 'title'),
            seatKind: BuiltValueNullFieldError.checkNotNull(
                seatKind, r'Seat', 'seatKind'),
            fillMode: BuiltValueNullFieldError.checkNotNull(
                fillMode, r'Seat', 'fillMode'),
            holderCardinality: BuiltValueNullFieldError.checkNotNull(
                holderCardinality, r'Seat', 'holderCardinality'),
            voting: BuiltValueNullFieldError.checkNotNull(
                voting, r'Seat', 'voting'),
            state:
                BuiltValueNullFieldError.checkNotNull(state, r'Seat', 'state'),
            holders: holders.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'holders';
        holders.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(r'Seat', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
