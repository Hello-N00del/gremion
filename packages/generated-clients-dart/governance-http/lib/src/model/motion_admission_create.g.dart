// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'motion_admission_create.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const MotionAdmissionCreateOutcomeEnum
    _$motionAdmissionCreateOutcomeEnum_admit =
    const MotionAdmissionCreateOutcomeEnum._('admit');
const MotionAdmissionCreateOutcomeEnum
    _$motionAdmissionCreateOutcomeEnum_defer =
    const MotionAdmissionCreateOutcomeEnum._('defer');
const MotionAdmissionCreateOutcomeEnum
    _$motionAdmissionCreateOutcomeEnum_unknownDefaultOpenApi =
    const MotionAdmissionCreateOutcomeEnum._('unknownDefaultOpenApi');

MotionAdmissionCreateOutcomeEnum _$motionAdmissionCreateOutcomeEnumValueOf(
    String name) {
  switch (name) {
    case 'admit':
      return _$motionAdmissionCreateOutcomeEnum_admit;
    case 'defer':
      return _$motionAdmissionCreateOutcomeEnum_defer;
    case 'unknownDefaultOpenApi':
      return _$motionAdmissionCreateOutcomeEnum_unknownDefaultOpenApi;
    default:
      return _$motionAdmissionCreateOutcomeEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MotionAdmissionCreateOutcomeEnum>
    _$motionAdmissionCreateOutcomeEnumValues = BuiltSet<
        MotionAdmissionCreateOutcomeEnum>(const <MotionAdmissionCreateOutcomeEnum>[
  _$motionAdmissionCreateOutcomeEnum_admit,
  _$motionAdmissionCreateOutcomeEnum_defer,
  _$motionAdmissionCreateOutcomeEnum_unknownDefaultOpenApi,
]);

Serializer<MotionAdmissionCreateOutcomeEnum>
    _$motionAdmissionCreateOutcomeEnumSerializer =
    _$MotionAdmissionCreateOutcomeEnumSerializer();

class _$MotionAdmissionCreateOutcomeEnumSerializer
    implements PrimitiveSerializer<MotionAdmissionCreateOutcomeEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'admit': 'admit',
    'defer': 'defer',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'admit': 'admit',
    'defer': 'defer',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[MotionAdmissionCreateOutcomeEnum];
  @override
  final String wireName = 'MotionAdmissionCreateOutcomeEnum';

  @override
  Object serialize(
          Serializers serializers, MotionAdmissionCreateOutcomeEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MotionAdmissionCreateOutcomeEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MotionAdmissionCreateOutcomeEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$MotionAdmissionCreate extends MotionAdmissionCreate {
  @override
  final MotionAdmissionCreateOutcomeEnum outcome;
  @override
  final String? deferredToMeetingId;
  @override
  final bool? deferToNextMeeting;

  factory _$MotionAdmissionCreate(
          [void Function(MotionAdmissionCreateBuilder)? updates]) =>
      (MotionAdmissionCreateBuilder()..update(updates))._build();

  _$MotionAdmissionCreate._(
      {required this.outcome,
      this.deferredToMeetingId,
      this.deferToNextMeeting})
      : super._();
  @override
  MotionAdmissionCreate rebuild(
          void Function(MotionAdmissionCreateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MotionAdmissionCreateBuilder toBuilder() =>
      MotionAdmissionCreateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MotionAdmissionCreate &&
        outcome == other.outcome &&
        deferredToMeetingId == other.deferredToMeetingId &&
        deferToNextMeeting == other.deferToNextMeeting;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, outcome.hashCode);
    _$hash = $jc(_$hash, deferredToMeetingId.hashCode);
    _$hash = $jc(_$hash, deferToNextMeeting.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'MotionAdmissionCreate')
          ..add('outcome', outcome)
          ..add('deferredToMeetingId', deferredToMeetingId)
          ..add('deferToNextMeeting', deferToNextMeeting))
        .toString();
  }
}

class MotionAdmissionCreateBuilder
    implements Builder<MotionAdmissionCreate, MotionAdmissionCreateBuilder> {
  _$MotionAdmissionCreate? _$v;

  MotionAdmissionCreateOutcomeEnum? _outcome;
  MotionAdmissionCreateOutcomeEnum? get outcome => _$this._outcome;
  set outcome(MotionAdmissionCreateOutcomeEnum? outcome) =>
      _$this._outcome = outcome;

  String? _deferredToMeetingId;
  String? get deferredToMeetingId => _$this._deferredToMeetingId;
  set deferredToMeetingId(String? deferredToMeetingId) =>
      _$this._deferredToMeetingId = deferredToMeetingId;

  bool? _deferToNextMeeting;
  bool? get deferToNextMeeting => _$this._deferToNextMeeting;
  set deferToNextMeeting(bool? deferToNextMeeting) =>
      _$this._deferToNextMeeting = deferToNextMeeting;

  MotionAdmissionCreateBuilder() {
    MotionAdmissionCreate._defaults(this);
  }

  MotionAdmissionCreateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _outcome = $v.outcome;
      _deferredToMeetingId = $v.deferredToMeetingId;
      _deferToNextMeeting = $v.deferToNextMeeting;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MotionAdmissionCreate other) {
    _$v = other as _$MotionAdmissionCreate;
  }

  @override
  void update(void Function(MotionAdmissionCreateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MotionAdmissionCreate build() => _build();

  _$MotionAdmissionCreate _build() {
    final _$result = _$v ??
        _$MotionAdmissionCreate._(
          outcome: BuiltValueNullFieldError.checkNotNull(
              outcome, r'MotionAdmissionCreate', 'outcome'),
          deferredToMeetingId: deferredToMeetingId,
          deferToNextMeeting: deferToNextMeeting,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
