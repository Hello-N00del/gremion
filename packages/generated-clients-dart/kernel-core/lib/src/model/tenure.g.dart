// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'tenure.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const TenureEndReasonEnum _$tenureEndReasonEnum_termEnd =
    const TenureEndReasonEnum._('termEnd');
const TenureEndReasonEnum _$tenureEndReasonEnum_resigned =
    const TenureEndReasonEnum._('resigned');
const TenureEndReasonEnum _$tenureEndReasonEnum_removed =
    const TenureEndReasonEnum._('removed');
const TenureEndReasonEnum _$tenureEndReasonEnum_succeeded =
    const TenureEndReasonEnum._('succeeded');
const TenureEndReasonEnum _$tenureEndReasonEnum_dataCorrection =
    const TenureEndReasonEnum._('dataCorrection');
const TenureEndReasonEnum _$tenureEndReasonEnum_unknownDefaultOpenApi =
    const TenureEndReasonEnum._('unknownDefaultOpenApi');

TenureEndReasonEnum _$tenureEndReasonEnumValueOf(String name) {
  switch (name) {
    case 'termEnd':
      return _$tenureEndReasonEnum_termEnd;
    case 'resigned':
      return _$tenureEndReasonEnum_resigned;
    case 'removed':
      return _$tenureEndReasonEnum_removed;
    case 'succeeded':
      return _$tenureEndReasonEnum_succeeded;
    case 'dataCorrection':
      return _$tenureEndReasonEnum_dataCorrection;
    case 'unknownDefaultOpenApi':
      return _$tenureEndReasonEnum_unknownDefaultOpenApi;
    default:
      return _$tenureEndReasonEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<TenureEndReasonEnum> _$tenureEndReasonEnumValues =
    BuiltSet<TenureEndReasonEnum>(const <TenureEndReasonEnum>[
  _$tenureEndReasonEnum_termEnd,
  _$tenureEndReasonEnum_resigned,
  _$tenureEndReasonEnum_removed,
  _$tenureEndReasonEnum_succeeded,
  _$tenureEndReasonEnum_dataCorrection,
  _$tenureEndReasonEnum_unknownDefaultOpenApi,
]);

const TenureSource_Enum _$tenureSourceEnum_election =
    const TenureSource_Enum._('election');
const TenureSource_Enum _$tenureSourceEnum_delegation =
    const TenureSource_Enum._('delegation');
const TenureSource_Enum _$tenureSourceEnum_appointment =
    const TenureSource_Enum._('appointment');
const TenureSource_Enum _$tenureSourceEnum_succession =
    const TenureSource_Enum._('succession');
const TenureSource_Enum _$tenureSourceEnum_unknownDefaultOpenApi =
    const TenureSource_Enum._('unknownDefaultOpenApi');

TenureSource_Enum _$tenureSourceEnumValueOf(String name) {
  switch (name) {
    case 'election':
      return _$tenureSourceEnum_election;
    case 'delegation':
      return _$tenureSourceEnum_delegation;
    case 'appointment':
      return _$tenureSourceEnum_appointment;
    case 'succession':
      return _$tenureSourceEnum_succession;
    case 'unknownDefaultOpenApi':
      return _$tenureSourceEnum_unknownDefaultOpenApi;
    default:
      return _$tenureSourceEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<TenureSource_Enum> _$tenureSourceEnumValues =
    BuiltSet<TenureSource_Enum>(const <TenureSource_Enum>[
  _$tenureSourceEnum_election,
  _$tenureSourceEnum_delegation,
  _$tenureSourceEnum_appointment,
  _$tenureSourceEnum_succession,
  _$tenureSourceEnum_unknownDefaultOpenApi,
]);

Serializer<TenureEndReasonEnum> _$tenureEndReasonEnumSerializer =
    _$TenureEndReasonEnumSerializer();
Serializer<TenureSource_Enum> _$tenureSourceEnumSerializer =
    _$TenureSource_EnumSerializer();

class _$TenureEndReasonEnumSerializer
    implements PrimitiveSerializer<TenureEndReasonEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'termEnd': 'term_end',
    'resigned': 'resigned',
    'removed': 'removed',
    'succeeded': 'succeeded',
    'dataCorrection': 'data_correction',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'term_end': 'termEnd',
    'resigned': 'resigned',
    'removed': 'removed',
    'succeeded': 'succeeded',
    'data_correction': 'dataCorrection',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[TenureEndReasonEnum];
  @override
  final String wireName = 'TenureEndReasonEnum';

  @override
  Object serialize(Serializers serializers, TenureEndReasonEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  TenureEndReasonEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      TenureEndReasonEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$TenureSource_EnumSerializer
    implements PrimitiveSerializer<TenureSource_Enum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'election': 'election',
    'delegation': 'delegation',
    'appointment': 'appointment',
    'succession': 'succession',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'election': 'election',
    'delegation': 'delegation',
    'appointment': 'appointment',
    'succession': 'succession',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[TenureSource_Enum];
  @override
  final String wireName = 'TenureSource_Enum';

  @override
  Object serialize(Serializers serializers, TenureSource_Enum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  TenureSource_Enum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      TenureSource_Enum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Tenure extends Tenure {
  @override
  final String tenureId;
  @override
  final String personId;
  @override
  final String? wahlperiodeId;
  @override
  final Date startsOn;
  @override
  final Date? plannedEndOn;
  @override
  final Date? endedOn;
  @override
  final TenureEndReasonEnum? endReason;
  @override
  final TenureSource_Enum source_;

  factory _$Tenure([void Function(TenureBuilder)? updates]) =>
      (TenureBuilder()..update(updates))._build();

  _$Tenure._(
      {required this.tenureId,
      required this.personId,
      this.wahlperiodeId,
      required this.startsOn,
      this.plannedEndOn,
      this.endedOn,
      this.endReason,
      required this.source_})
      : super._();
  @override
  Tenure rebuild(void Function(TenureBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  TenureBuilder toBuilder() => TenureBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Tenure &&
        tenureId == other.tenureId &&
        personId == other.personId &&
        wahlperiodeId == other.wahlperiodeId &&
        startsOn == other.startsOn &&
        plannedEndOn == other.plannedEndOn &&
        endedOn == other.endedOn &&
        endReason == other.endReason &&
        source_ == other.source_;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, tenureId.hashCode);
    _$hash = $jc(_$hash, personId.hashCode);
    _$hash = $jc(_$hash, wahlperiodeId.hashCode);
    _$hash = $jc(_$hash, startsOn.hashCode);
    _$hash = $jc(_$hash, plannedEndOn.hashCode);
    _$hash = $jc(_$hash, endedOn.hashCode);
    _$hash = $jc(_$hash, endReason.hashCode);
    _$hash = $jc(_$hash, source_.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Tenure')
          ..add('tenureId', tenureId)
          ..add('personId', personId)
          ..add('wahlperiodeId', wahlperiodeId)
          ..add('startsOn', startsOn)
          ..add('plannedEndOn', plannedEndOn)
          ..add('endedOn', endedOn)
          ..add('endReason', endReason)
          ..add('source_', source_))
        .toString();
  }
}

class TenureBuilder implements Builder<Tenure, TenureBuilder> {
  _$Tenure? _$v;

  String? _tenureId;
  String? get tenureId => _$this._tenureId;
  set tenureId(String? tenureId) => _$this._tenureId = tenureId;

  String? _personId;
  String? get personId => _$this._personId;
  set personId(String? personId) => _$this._personId = personId;

  String? _wahlperiodeId;
  String? get wahlperiodeId => _$this._wahlperiodeId;
  set wahlperiodeId(String? wahlperiodeId) =>
      _$this._wahlperiodeId = wahlperiodeId;

  Date? _startsOn;
  Date? get startsOn => _$this._startsOn;
  set startsOn(Date? startsOn) => _$this._startsOn = startsOn;

  Date? _plannedEndOn;
  Date? get plannedEndOn => _$this._plannedEndOn;
  set plannedEndOn(Date? plannedEndOn) => _$this._plannedEndOn = plannedEndOn;

  Date? _endedOn;
  Date? get endedOn => _$this._endedOn;
  set endedOn(Date? endedOn) => _$this._endedOn = endedOn;

  TenureEndReasonEnum? _endReason;
  TenureEndReasonEnum? get endReason => _$this._endReason;
  set endReason(TenureEndReasonEnum? endReason) =>
      _$this._endReason = endReason;

  TenureSource_Enum? _source_;
  TenureSource_Enum? get source_ => _$this._source_;
  set source_(TenureSource_Enum? source_) => _$this._source_ = source_;

  TenureBuilder() {
    Tenure._defaults(this);
  }

  TenureBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _tenureId = $v.tenureId;
      _personId = $v.personId;
      _wahlperiodeId = $v.wahlperiodeId;
      _startsOn = $v.startsOn;
      _plannedEndOn = $v.plannedEndOn;
      _endedOn = $v.endedOn;
      _endReason = $v.endReason;
      _source_ = $v.source_;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Tenure other) {
    _$v = other as _$Tenure;
  }

  @override
  void update(void Function(TenureBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Tenure build() => _build();

  _$Tenure _build() {
    final _$result = _$v ??
        _$Tenure._(
          tenureId: BuiltValueNullFieldError.checkNotNull(
              tenureId, r'Tenure', 'tenureId'),
          personId: BuiltValueNullFieldError.checkNotNull(
              personId, r'Tenure', 'personId'),
          wahlperiodeId: wahlperiodeId,
          startsOn: BuiltValueNullFieldError.checkNotNull(
              startsOn, r'Tenure', 'startsOn'),
          plannedEndOn: plannedEndOn,
          endedOn: endedOn,
          endReason: endReason,
          source_: BuiltValueNullFieldError.checkNotNull(
              source_, r'Tenure', 'source_'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
