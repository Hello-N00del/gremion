// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'motion_admission.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const MotionAdmissionOutcomeEnum _$motionAdmissionOutcomeEnum_admit =
    const MotionAdmissionOutcomeEnum._('admit');
const MotionAdmissionOutcomeEnum _$motionAdmissionOutcomeEnum_defer =
    const MotionAdmissionOutcomeEnum._('defer');
const MotionAdmissionOutcomeEnum
    _$motionAdmissionOutcomeEnum_unknownDefaultOpenApi =
    const MotionAdmissionOutcomeEnum._('unknownDefaultOpenApi');

MotionAdmissionOutcomeEnum _$motionAdmissionOutcomeEnumValueOf(String name) {
  switch (name) {
    case 'admit':
      return _$motionAdmissionOutcomeEnum_admit;
    case 'defer':
      return _$motionAdmissionOutcomeEnum_defer;
    case 'unknownDefaultOpenApi':
      return _$motionAdmissionOutcomeEnum_unknownDefaultOpenApi;
    default:
      return _$motionAdmissionOutcomeEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MotionAdmissionOutcomeEnum> _$motionAdmissionOutcomeEnumValues =
    BuiltSet<MotionAdmissionOutcomeEnum>(const <MotionAdmissionOutcomeEnum>[
  _$motionAdmissionOutcomeEnum_admit,
  _$motionAdmissionOutcomeEnum_defer,
  _$motionAdmissionOutcomeEnum_unknownDefaultOpenApi,
]);

Serializer<MotionAdmissionOutcomeEnum> _$motionAdmissionOutcomeEnumSerializer =
    _$MotionAdmissionOutcomeEnumSerializer();

class _$MotionAdmissionOutcomeEnumSerializer
    implements PrimitiveSerializer<MotionAdmissionOutcomeEnum> {
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
  final Iterable<Type> types = const <Type>[MotionAdmissionOutcomeEnum];
  @override
  final String wireName = 'MotionAdmissionOutcomeEnum';

  @override
  Object serialize(Serializers serializers, MotionAdmissionOutcomeEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MotionAdmissionOutcomeEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MotionAdmissionOutcomeEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$MotionAdmission extends MotionAdmission {
  @override
  final String admissionId;
  @override
  final String motionId;
  @override
  final MotionAdmissionOutcomeEnum outcome;
  @override
  final String? deferredToMeetingId;
  @override
  final bool deferToNextMeeting;
  @override
  final String actorPersonId;
  @override
  final DateTime decidedAt;

  factory _$MotionAdmission([void Function(MotionAdmissionBuilder)? updates]) =>
      (MotionAdmissionBuilder()..update(updates))._build();

  _$MotionAdmission._(
      {required this.admissionId,
      required this.motionId,
      required this.outcome,
      this.deferredToMeetingId,
      required this.deferToNextMeeting,
      required this.actorPersonId,
      required this.decidedAt})
      : super._();
  @override
  MotionAdmission rebuild(void Function(MotionAdmissionBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MotionAdmissionBuilder toBuilder() => MotionAdmissionBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MotionAdmission &&
        admissionId == other.admissionId &&
        motionId == other.motionId &&
        outcome == other.outcome &&
        deferredToMeetingId == other.deferredToMeetingId &&
        deferToNextMeeting == other.deferToNextMeeting &&
        actorPersonId == other.actorPersonId &&
        decidedAt == other.decidedAt;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, admissionId.hashCode);
    _$hash = $jc(_$hash, motionId.hashCode);
    _$hash = $jc(_$hash, outcome.hashCode);
    _$hash = $jc(_$hash, deferredToMeetingId.hashCode);
    _$hash = $jc(_$hash, deferToNextMeeting.hashCode);
    _$hash = $jc(_$hash, actorPersonId.hashCode);
    _$hash = $jc(_$hash, decidedAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'MotionAdmission')
          ..add('admissionId', admissionId)
          ..add('motionId', motionId)
          ..add('outcome', outcome)
          ..add('deferredToMeetingId', deferredToMeetingId)
          ..add('deferToNextMeeting', deferToNextMeeting)
          ..add('actorPersonId', actorPersonId)
          ..add('decidedAt', decidedAt))
        .toString();
  }
}

class MotionAdmissionBuilder
    implements Builder<MotionAdmission, MotionAdmissionBuilder> {
  _$MotionAdmission? _$v;

  String? _admissionId;
  String? get admissionId => _$this._admissionId;
  set admissionId(String? admissionId) => _$this._admissionId = admissionId;

  String? _motionId;
  String? get motionId => _$this._motionId;
  set motionId(String? motionId) => _$this._motionId = motionId;

  MotionAdmissionOutcomeEnum? _outcome;
  MotionAdmissionOutcomeEnum? get outcome => _$this._outcome;
  set outcome(MotionAdmissionOutcomeEnum? outcome) => _$this._outcome = outcome;

  String? _deferredToMeetingId;
  String? get deferredToMeetingId => _$this._deferredToMeetingId;
  set deferredToMeetingId(String? deferredToMeetingId) =>
      _$this._deferredToMeetingId = deferredToMeetingId;

  bool? _deferToNextMeeting;
  bool? get deferToNextMeeting => _$this._deferToNextMeeting;
  set deferToNextMeeting(bool? deferToNextMeeting) =>
      _$this._deferToNextMeeting = deferToNextMeeting;

  String? _actorPersonId;
  String? get actorPersonId => _$this._actorPersonId;
  set actorPersonId(String? actorPersonId) =>
      _$this._actorPersonId = actorPersonId;

  DateTime? _decidedAt;
  DateTime? get decidedAt => _$this._decidedAt;
  set decidedAt(DateTime? decidedAt) => _$this._decidedAt = decidedAt;

  MotionAdmissionBuilder() {
    MotionAdmission._defaults(this);
  }

  MotionAdmissionBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _admissionId = $v.admissionId;
      _motionId = $v.motionId;
      _outcome = $v.outcome;
      _deferredToMeetingId = $v.deferredToMeetingId;
      _deferToNextMeeting = $v.deferToNextMeeting;
      _actorPersonId = $v.actorPersonId;
      _decidedAt = $v.decidedAt;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MotionAdmission other) {
    _$v = other as _$MotionAdmission;
  }

  @override
  void update(void Function(MotionAdmissionBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MotionAdmission build() => _build();

  _$MotionAdmission _build() {
    final _$result = _$v ??
        _$MotionAdmission._(
          admissionId: BuiltValueNullFieldError.checkNotNull(
              admissionId, r'MotionAdmission', 'admissionId'),
          motionId: BuiltValueNullFieldError.checkNotNull(
              motionId, r'MotionAdmission', 'motionId'),
          outcome: BuiltValueNullFieldError.checkNotNull(
              outcome, r'MotionAdmission', 'outcome'),
          deferredToMeetingId: deferredToMeetingId,
          deferToNextMeeting: BuiltValueNullFieldError.checkNotNull(
              deferToNextMeeting, r'MotionAdmission', 'deferToNextMeeting'),
          actorPersonId: BuiltValueNullFieldError.checkNotNull(
              actorPersonId, r'MotionAdmission', 'actorPersonId'),
          decidedAt: BuiltValueNullFieldError.checkNotNull(
              decidedAt, r'MotionAdmission', 'decidedAt'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
