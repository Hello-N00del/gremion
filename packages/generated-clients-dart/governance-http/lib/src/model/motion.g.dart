// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'motion.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const MotionSubmitterKindEnum _$motionSubmitterKindEnum_member =
    const MotionSubmitterKindEnum._('member');
const MotionSubmitterKindEnum _$motionSubmitterKindEnum_helper =
    const MotionSubmitterKindEnum._('helper');
const MotionSubmitterKindEnum _$motionSubmitterKindEnum_public =
    const MotionSubmitterKindEnum._('public');
const MotionSubmitterKindEnum _$motionSubmitterKindEnum_unknownDefaultOpenApi =
    const MotionSubmitterKindEnum._('unknownDefaultOpenApi');

MotionSubmitterKindEnum _$motionSubmitterKindEnumValueOf(String name) {
  switch (name) {
    case 'member':
      return _$motionSubmitterKindEnum_member;
    case 'helper':
      return _$motionSubmitterKindEnum_helper;
    case 'public':
      return _$motionSubmitterKindEnum_public;
    case 'unknownDefaultOpenApi':
      return _$motionSubmitterKindEnum_unknownDefaultOpenApi;
    default:
      return _$motionSubmitterKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MotionSubmitterKindEnum> _$motionSubmitterKindEnumValues =
    BuiltSet<MotionSubmitterKindEnum>(const <MotionSubmitterKindEnum>[
  _$motionSubmitterKindEnum_member,
  _$motionSubmitterKindEnum_helper,
  _$motionSubmitterKindEnum_public,
  _$motionSubmitterKindEnum_unknownDefaultOpenApi,
]);

const MotionStateEnum _$motionStateEnum_draft =
    const MotionStateEnum._('draft');
const MotionStateEnum _$motionStateEnum_pendingVerification =
    const MotionStateEnum._('pendingVerification');
const MotionStateEnum _$motionStateEnum_submitted =
    const MotionStateEnum._('submitted');
const MotionStateEnum _$motionStateEnum_onAgenda =
    const MotionStateEnum._('onAgenda');
const MotionStateEnum _$motionStateEnum_withheld =
    const MotionStateEnum._('withheld');
const MotionStateEnum _$motionStateEnum_deferred_ =
    const MotionStateEnum._('deferred_');
const MotionStateEnum _$motionStateEnum_decided =
    const MotionStateEnum._('decided');
const MotionStateEnum _$motionStateEnum_adjourned =
    const MotionStateEnum._('adjourned');
const MotionStateEnum _$motionStateEnum_withdrawn =
    const MotionStateEnum._('withdrawn');
const MotionStateEnum _$motionStateEnum_expired =
    const MotionStateEnum._('expired');
const MotionStateEnum _$motionStateEnum_unknownDefaultOpenApi =
    const MotionStateEnum._('unknownDefaultOpenApi');

MotionStateEnum _$motionStateEnumValueOf(String name) {
  switch (name) {
    case 'draft':
      return _$motionStateEnum_draft;
    case 'pendingVerification':
      return _$motionStateEnum_pendingVerification;
    case 'submitted':
      return _$motionStateEnum_submitted;
    case 'onAgenda':
      return _$motionStateEnum_onAgenda;
    case 'withheld':
      return _$motionStateEnum_withheld;
    case 'deferred_':
      return _$motionStateEnum_deferred_;
    case 'decided':
      return _$motionStateEnum_decided;
    case 'adjourned':
      return _$motionStateEnum_adjourned;
    case 'withdrawn':
      return _$motionStateEnum_withdrawn;
    case 'expired':
      return _$motionStateEnum_expired;
    case 'unknownDefaultOpenApi':
      return _$motionStateEnum_unknownDefaultOpenApi;
    default:
      return _$motionStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MotionStateEnum> _$motionStateEnumValues =
    BuiltSet<MotionStateEnum>(const <MotionStateEnum>[
  _$motionStateEnum_draft,
  _$motionStateEnum_pendingVerification,
  _$motionStateEnum_submitted,
  _$motionStateEnum_onAgenda,
  _$motionStateEnum_withheld,
  _$motionStateEnum_deferred_,
  _$motionStateEnum_decided,
  _$motionStateEnum_adjourned,
  _$motionStateEnum_withdrawn,
  _$motionStateEnum_expired,
  _$motionStateEnum_unknownDefaultOpenApi,
]);

const MotionPublicationClassEnum _$motionPublicationClassEnum_public =
    const MotionPublicationClassEnum._('public');
const MotionPublicationClassEnum _$motionPublicationClassEnum_nonPublic =
    const MotionPublicationClassEnum._('nonPublic');
const MotionPublicationClassEnum
    _$motionPublicationClassEnum_unknownDefaultOpenApi =
    const MotionPublicationClassEnum._('unknownDefaultOpenApi');

MotionPublicationClassEnum _$motionPublicationClassEnumValueOf(String name) {
  switch (name) {
    case 'public':
      return _$motionPublicationClassEnum_public;
    case 'nonPublic':
      return _$motionPublicationClassEnum_nonPublic;
    case 'unknownDefaultOpenApi':
      return _$motionPublicationClassEnum_unknownDefaultOpenApi;
    default:
      return _$motionPublicationClassEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MotionPublicationClassEnum> _$motionPublicationClassEnumValues =
    BuiltSet<MotionPublicationClassEnum>(const <MotionPublicationClassEnum>[
  _$motionPublicationClassEnum_public,
  _$motionPublicationClassEnum_nonPublic,
  _$motionPublicationClassEnum_unknownDefaultOpenApi,
]);

Serializer<MotionSubmitterKindEnum> _$motionSubmitterKindEnumSerializer =
    _$MotionSubmitterKindEnumSerializer();
Serializer<MotionStateEnum> _$motionStateEnumSerializer =
    _$MotionStateEnumSerializer();
Serializer<MotionPublicationClassEnum> _$motionPublicationClassEnumSerializer =
    _$MotionPublicationClassEnumSerializer();

class _$MotionSubmitterKindEnumSerializer
    implements PrimitiveSerializer<MotionSubmitterKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'member': 'member',
    'helper': 'helper',
    'public': 'public',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'member': 'member',
    'helper': 'helper',
    'public': 'public',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[MotionSubmitterKindEnum];
  @override
  final String wireName = 'MotionSubmitterKindEnum';

  @override
  Object serialize(Serializers serializers, MotionSubmitterKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MotionSubmitterKindEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MotionSubmitterKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$MotionStateEnumSerializer
    implements PrimitiveSerializer<MotionStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'draft': 'draft',
    'pendingVerification': 'pending_verification',
    'submitted': 'submitted',
    'onAgenda': 'on_agenda',
    'withheld': 'withheld',
    'deferred_': 'deferred',
    'decided': 'decided',
    'adjourned': 'adjourned',
    'withdrawn': 'withdrawn',
    'expired': 'expired',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'draft': 'draft',
    'pending_verification': 'pendingVerification',
    'submitted': 'submitted',
    'on_agenda': 'onAgenda',
    'withheld': 'withheld',
    'deferred': 'deferred_',
    'decided': 'decided',
    'adjourned': 'adjourned',
    'withdrawn': 'withdrawn',
    'expired': 'expired',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[MotionStateEnum];
  @override
  final String wireName = 'MotionStateEnum';

  @override
  Object serialize(Serializers serializers, MotionStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MotionStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MotionStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$MotionPublicationClassEnumSerializer
    implements PrimitiveSerializer<MotionPublicationClassEnum> {
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
  final Iterable<Type> types = const <Type>[MotionPublicationClassEnum];
  @override
  final String wireName = 'MotionPublicationClassEnum';

  @override
  Object serialize(Serializers serializers, MotionPublicationClassEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MotionPublicationClassEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MotionPublicationClassEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Motion extends Motion {
  @override
  final String motionId;
  @override
  final String? targetMeetingId;
  @override
  final String? agendaItemId;
  @override
  final String? referenceLabel;
  @override
  final String title;
  @override
  final String motionText;
  @override
  final String? rationale;
  @override
  final MotionSubmitterKindEnum submitterKind;
  @override
  final String? submitterPersonId;
  @override
  final DateTime? submittedAt;
  @override
  final DateTime? deadlineSnapshot;
  @override
  final bool? isLate;
  @override
  final MotionStateEnum state;
  @override
  final MotionPublicationClassEnum? publicationClass;

  factory _$Motion([void Function(MotionBuilder)? updates]) =>
      (MotionBuilder()..update(updates))._build();

  _$Motion._(
      {required this.motionId,
      this.targetMeetingId,
      this.agendaItemId,
      this.referenceLabel,
      required this.title,
      required this.motionText,
      this.rationale,
      required this.submitterKind,
      this.submitterPersonId,
      this.submittedAt,
      this.deadlineSnapshot,
      this.isLate,
      required this.state,
      this.publicationClass})
      : super._();
  @override
  Motion rebuild(void Function(MotionBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MotionBuilder toBuilder() => MotionBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Motion &&
        motionId == other.motionId &&
        targetMeetingId == other.targetMeetingId &&
        agendaItemId == other.agendaItemId &&
        referenceLabel == other.referenceLabel &&
        title == other.title &&
        motionText == other.motionText &&
        rationale == other.rationale &&
        submitterKind == other.submitterKind &&
        submitterPersonId == other.submitterPersonId &&
        submittedAt == other.submittedAt &&
        deadlineSnapshot == other.deadlineSnapshot &&
        isLate == other.isLate &&
        state == other.state &&
        publicationClass == other.publicationClass;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, motionId.hashCode);
    _$hash = $jc(_$hash, targetMeetingId.hashCode);
    _$hash = $jc(_$hash, agendaItemId.hashCode);
    _$hash = $jc(_$hash, referenceLabel.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, motionText.hashCode);
    _$hash = $jc(_$hash, rationale.hashCode);
    _$hash = $jc(_$hash, submitterKind.hashCode);
    _$hash = $jc(_$hash, submitterPersonId.hashCode);
    _$hash = $jc(_$hash, submittedAt.hashCode);
    _$hash = $jc(_$hash, deadlineSnapshot.hashCode);
    _$hash = $jc(_$hash, isLate.hashCode);
    _$hash = $jc(_$hash, state.hashCode);
    _$hash = $jc(_$hash, publicationClass.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Motion')
          ..add('motionId', motionId)
          ..add('targetMeetingId', targetMeetingId)
          ..add('agendaItemId', agendaItemId)
          ..add('referenceLabel', referenceLabel)
          ..add('title', title)
          ..add('motionText', motionText)
          ..add('rationale', rationale)
          ..add('submitterKind', submitterKind)
          ..add('submitterPersonId', submitterPersonId)
          ..add('submittedAt', submittedAt)
          ..add('deadlineSnapshot', deadlineSnapshot)
          ..add('isLate', isLate)
          ..add('state', state)
          ..add('publicationClass', publicationClass))
        .toString();
  }
}

class MotionBuilder implements Builder<Motion, MotionBuilder> {
  _$Motion? _$v;

  String? _motionId;
  String? get motionId => _$this._motionId;
  set motionId(String? motionId) => _$this._motionId = motionId;

  String? _targetMeetingId;
  String? get targetMeetingId => _$this._targetMeetingId;
  set targetMeetingId(String? targetMeetingId) =>
      _$this._targetMeetingId = targetMeetingId;

  String? _agendaItemId;
  String? get agendaItemId => _$this._agendaItemId;
  set agendaItemId(String? agendaItemId) => _$this._agendaItemId = agendaItemId;

  String? _referenceLabel;
  String? get referenceLabel => _$this._referenceLabel;
  set referenceLabel(String? referenceLabel) =>
      _$this._referenceLabel = referenceLabel;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  String? _motionText;
  String? get motionText => _$this._motionText;
  set motionText(String? motionText) => _$this._motionText = motionText;

  String? _rationale;
  String? get rationale => _$this._rationale;
  set rationale(String? rationale) => _$this._rationale = rationale;

  MotionSubmitterKindEnum? _submitterKind;
  MotionSubmitterKindEnum? get submitterKind => _$this._submitterKind;
  set submitterKind(MotionSubmitterKindEnum? submitterKind) =>
      _$this._submitterKind = submitterKind;

  String? _submitterPersonId;
  String? get submitterPersonId => _$this._submitterPersonId;
  set submitterPersonId(String? submitterPersonId) =>
      _$this._submitterPersonId = submitterPersonId;

  DateTime? _submittedAt;
  DateTime? get submittedAt => _$this._submittedAt;
  set submittedAt(DateTime? submittedAt) => _$this._submittedAt = submittedAt;

  DateTime? _deadlineSnapshot;
  DateTime? get deadlineSnapshot => _$this._deadlineSnapshot;
  set deadlineSnapshot(DateTime? deadlineSnapshot) =>
      _$this._deadlineSnapshot = deadlineSnapshot;

  bool? _isLate;
  bool? get isLate => _$this._isLate;
  set isLate(bool? isLate) => _$this._isLate = isLate;

  MotionStateEnum? _state;
  MotionStateEnum? get state => _$this._state;
  set state(MotionStateEnum? state) => _$this._state = state;

  MotionPublicationClassEnum? _publicationClass;
  MotionPublicationClassEnum? get publicationClass => _$this._publicationClass;
  set publicationClass(MotionPublicationClassEnum? publicationClass) =>
      _$this._publicationClass = publicationClass;

  MotionBuilder() {
    Motion._defaults(this);
  }

  MotionBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _motionId = $v.motionId;
      _targetMeetingId = $v.targetMeetingId;
      _agendaItemId = $v.agendaItemId;
      _referenceLabel = $v.referenceLabel;
      _title = $v.title;
      _motionText = $v.motionText;
      _rationale = $v.rationale;
      _submitterKind = $v.submitterKind;
      _submitterPersonId = $v.submitterPersonId;
      _submittedAt = $v.submittedAt;
      _deadlineSnapshot = $v.deadlineSnapshot;
      _isLate = $v.isLate;
      _state = $v.state;
      _publicationClass = $v.publicationClass;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Motion other) {
    _$v = other as _$Motion;
  }

  @override
  void update(void Function(MotionBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Motion build() => _build();

  _$Motion _build() {
    final _$result = _$v ??
        _$Motion._(
          motionId: BuiltValueNullFieldError.checkNotNull(
              motionId, r'Motion', 'motionId'),
          targetMeetingId: targetMeetingId,
          agendaItemId: agendaItemId,
          referenceLabel: referenceLabel,
          title:
              BuiltValueNullFieldError.checkNotNull(title, r'Motion', 'title'),
          motionText: BuiltValueNullFieldError.checkNotNull(
              motionText, r'Motion', 'motionText'),
          rationale: rationale,
          submitterKind: BuiltValueNullFieldError.checkNotNull(
              submitterKind, r'Motion', 'submitterKind'),
          submitterPersonId: submitterPersonId,
          submittedAt: submittedAt,
          deadlineSnapshot: deadlineSnapshot,
          isLate: isLate,
          state:
              BuiltValueNullFieldError.checkNotNull(state, r'Motion', 'state'),
          publicationClass: publicationClass,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
