// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'meeting.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const MeetingStateEnum _$meetingStateEnum_planned =
    const MeetingStateEnum._('planned');
const MeetingStateEnum _$meetingStateEnum_invited =
    const MeetingStateEnum._('invited');
const MeetingStateEnum _$meetingStateEnum_inSession =
    const MeetingStateEnum._('inSession');
const MeetingStateEnum _$meetingStateEnum_suspended =
    const MeetingStateEnum._('suspended');
const MeetingStateEnum _$meetingStateEnum_closed =
    const MeetingStateEnum._('closed');
const MeetingStateEnum _$meetingStateEnum_cancelled =
    const MeetingStateEnum._('cancelled');
const MeetingStateEnum _$meetingStateEnum_unknownDefaultOpenApi =
    const MeetingStateEnum._('unknownDefaultOpenApi');

MeetingStateEnum _$meetingStateEnumValueOf(String name) {
  switch (name) {
    case 'planned':
      return _$meetingStateEnum_planned;
    case 'invited':
      return _$meetingStateEnum_invited;
    case 'inSession':
      return _$meetingStateEnum_inSession;
    case 'suspended':
      return _$meetingStateEnum_suspended;
    case 'closed':
      return _$meetingStateEnum_closed;
    case 'cancelled':
      return _$meetingStateEnum_cancelled;
    case 'unknownDefaultOpenApi':
      return _$meetingStateEnum_unknownDefaultOpenApi;
    default:
      return _$meetingStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MeetingStateEnum> _$meetingStateEnumValues =
    BuiltSet<MeetingStateEnum>(const <MeetingStateEnum>[
  _$meetingStateEnum_planned,
  _$meetingStateEnum_invited,
  _$meetingStateEnum_inSession,
  _$meetingStateEnum_suspended,
  _$meetingStateEnum_closed,
  _$meetingStateEnum_cancelled,
  _$meetingStateEnum_unknownDefaultOpenApi,
]);

const MeetingCancelReasonEnum _$meetingCancelReasonEnum_chairCancelled =
    const MeetingCancelReasonEnum._('chairCancelled');
const MeetingCancelReasonEnum _$meetingCancelReasonEnum_bodyArchived =
    const MeetingCancelReasonEnum._('bodyArchived');
const MeetingCancelReasonEnum _$meetingCancelReasonEnum_orgUnitArchived =
    const MeetingCancelReasonEnum._('orgUnitArchived');
const MeetingCancelReasonEnum _$meetingCancelReasonEnum_customerOffboarding =
    const MeetingCancelReasonEnum._('customerOffboarding');
const MeetingCancelReasonEnum _$meetingCancelReasonEnum_unknownDefaultOpenApi =
    const MeetingCancelReasonEnum._('unknownDefaultOpenApi');

MeetingCancelReasonEnum _$meetingCancelReasonEnumValueOf(String name) {
  switch (name) {
    case 'chairCancelled':
      return _$meetingCancelReasonEnum_chairCancelled;
    case 'bodyArchived':
      return _$meetingCancelReasonEnum_bodyArchived;
    case 'orgUnitArchived':
      return _$meetingCancelReasonEnum_orgUnitArchived;
    case 'customerOffboarding':
      return _$meetingCancelReasonEnum_customerOffboarding;
    case 'unknownDefaultOpenApi':
      return _$meetingCancelReasonEnum_unknownDefaultOpenApi;
    default:
      return _$meetingCancelReasonEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MeetingCancelReasonEnum> _$meetingCancelReasonEnumValues =
    BuiltSet<MeetingCancelReasonEnum>(const <MeetingCancelReasonEnum>[
  _$meetingCancelReasonEnum_chairCancelled,
  _$meetingCancelReasonEnum_bodyArchived,
  _$meetingCancelReasonEnum_orgUnitArchived,
  _$meetingCancelReasonEnum_customerOffboarding,
  _$meetingCancelReasonEnum_unknownDefaultOpenApi,
]);

Serializer<MeetingStateEnum> _$meetingStateEnumSerializer =
    _$MeetingStateEnumSerializer();
Serializer<MeetingCancelReasonEnum> _$meetingCancelReasonEnumSerializer =
    _$MeetingCancelReasonEnumSerializer();

class _$MeetingStateEnumSerializer
    implements PrimitiveSerializer<MeetingStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'planned': 'planned',
    'invited': 'invited',
    'inSession': 'in_session',
    'suspended': 'suspended',
    'closed': 'closed',
    'cancelled': 'cancelled',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'planned': 'planned',
    'invited': 'invited',
    'in_session': 'inSession',
    'suspended': 'suspended',
    'closed': 'closed',
    'cancelled': 'cancelled',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[MeetingStateEnum];
  @override
  final String wireName = 'MeetingStateEnum';

  @override
  Object serialize(Serializers serializers, MeetingStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MeetingStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MeetingStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$MeetingCancelReasonEnumSerializer
    implements PrimitiveSerializer<MeetingCancelReasonEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'chairCancelled': 'chair_cancelled',
    'bodyArchived': 'body_archived',
    'orgUnitArchived': 'org_unit_archived',
    'customerOffboarding': 'customer_offboarding',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'chair_cancelled': 'chairCancelled',
    'body_archived': 'bodyArchived',
    'org_unit_archived': 'orgUnitArchived',
    'customer_offboarding': 'customerOffboarding',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[MeetingCancelReasonEnum];
  @override
  final String wireName = 'MeetingCancelReasonEnum';

  @override
  Object serialize(Serializers serializers, MeetingCancelReasonEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MeetingCancelReasonEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MeetingCancelReasonEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Meeting extends Meeting {
  @override
  final String meetingId;
  @override
  final String bodyId;
  @override
  final String? orgUnitId;
  @override
  final String? wahlperiodeId;
  @override
  final int? meetingNumber;
  @override
  final String title;
  @override
  final DateTime scheduledStart;
  @override
  final DateTime? scheduledEnd;
  @override
  final String? location;
  @override
  final String? callLinkId;
  @override
  final MeetingStateEnum state;
  @override
  final int noticePeriodDaysSnapshot;
  @override
  final DateTime noticeDueAt;
  @override
  final DateTime? motionDeadlineAt;
  @override
  final DateTime? openedAt;
  @override
  final DateTime? closedAt;
  @override
  final MeetingCancelReasonEnum? cancelReason;

  factory _$Meeting([void Function(MeetingBuilder)? updates]) =>
      (MeetingBuilder()..update(updates))._build();

  _$Meeting._(
      {required this.meetingId,
      required this.bodyId,
      this.orgUnitId,
      this.wahlperiodeId,
      this.meetingNumber,
      required this.title,
      required this.scheduledStart,
      this.scheduledEnd,
      this.location,
      this.callLinkId,
      required this.state,
      required this.noticePeriodDaysSnapshot,
      required this.noticeDueAt,
      this.motionDeadlineAt,
      this.openedAt,
      this.closedAt,
      this.cancelReason})
      : super._();
  @override
  Meeting rebuild(void Function(MeetingBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MeetingBuilder toBuilder() => MeetingBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Meeting &&
        meetingId == other.meetingId &&
        bodyId == other.bodyId &&
        orgUnitId == other.orgUnitId &&
        wahlperiodeId == other.wahlperiodeId &&
        meetingNumber == other.meetingNumber &&
        title == other.title &&
        scheduledStart == other.scheduledStart &&
        scheduledEnd == other.scheduledEnd &&
        location == other.location &&
        callLinkId == other.callLinkId &&
        state == other.state &&
        noticePeriodDaysSnapshot == other.noticePeriodDaysSnapshot &&
        noticeDueAt == other.noticeDueAt &&
        motionDeadlineAt == other.motionDeadlineAt &&
        openedAt == other.openedAt &&
        closedAt == other.closedAt &&
        cancelReason == other.cancelReason;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, meetingId.hashCode);
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, wahlperiodeId.hashCode);
    _$hash = $jc(_$hash, meetingNumber.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, scheduledStart.hashCode);
    _$hash = $jc(_$hash, scheduledEnd.hashCode);
    _$hash = $jc(_$hash, location.hashCode);
    _$hash = $jc(_$hash, callLinkId.hashCode);
    _$hash = $jc(_$hash, state.hashCode);
    _$hash = $jc(_$hash, noticePeriodDaysSnapshot.hashCode);
    _$hash = $jc(_$hash, noticeDueAt.hashCode);
    _$hash = $jc(_$hash, motionDeadlineAt.hashCode);
    _$hash = $jc(_$hash, openedAt.hashCode);
    _$hash = $jc(_$hash, closedAt.hashCode);
    _$hash = $jc(_$hash, cancelReason.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Meeting')
          ..add('meetingId', meetingId)
          ..add('bodyId', bodyId)
          ..add('orgUnitId', orgUnitId)
          ..add('wahlperiodeId', wahlperiodeId)
          ..add('meetingNumber', meetingNumber)
          ..add('title', title)
          ..add('scheduledStart', scheduledStart)
          ..add('scheduledEnd', scheduledEnd)
          ..add('location', location)
          ..add('callLinkId', callLinkId)
          ..add('state', state)
          ..add('noticePeriodDaysSnapshot', noticePeriodDaysSnapshot)
          ..add('noticeDueAt', noticeDueAt)
          ..add('motionDeadlineAt', motionDeadlineAt)
          ..add('openedAt', openedAt)
          ..add('closedAt', closedAt)
          ..add('cancelReason', cancelReason))
        .toString();
  }
}

class MeetingBuilder implements Builder<Meeting, MeetingBuilder> {
  _$Meeting? _$v;

  String? _meetingId;
  String? get meetingId => _$this._meetingId;
  set meetingId(String? meetingId) => _$this._meetingId = meetingId;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  String? _wahlperiodeId;
  String? get wahlperiodeId => _$this._wahlperiodeId;
  set wahlperiodeId(String? wahlperiodeId) =>
      _$this._wahlperiodeId = wahlperiodeId;

  int? _meetingNumber;
  int? get meetingNumber => _$this._meetingNumber;
  set meetingNumber(int? meetingNumber) =>
      _$this._meetingNumber = meetingNumber;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  DateTime? _scheduledStart;
  DateTime? get scheduledStart => _$this._scheduledStart;
  set scheduledStart(DateTime? scheduledStart) =>
      _$this._scheduledStart = scheduledStart;

  DateTime? _scheduledEnd;
  DateTime? get scheduledEnd => _$this._scheduledEnd;
  set scheduledEnd(DateTime? scheduledEnd) =>
      _$this._scheduledEnd = scheduledEnd;

  String? _location;
  String? get location => _$this._location;
  set location(String? location) => _$this._location = location;

  String? _callLinkId;
  String? get callLinkId => _$this._callLinkId;
  set callLinkId(String? callLinkId) => _$this._callLinkId = callLinkId;

  MeetingStateEnum? _state;
  MeetingStateEnum? get state => _$this._state;
  set state(MeetingStateEnum? state) => _$this._state = state;

  int? _noticePeriodDaysSnapshot;
  int? get noticePeriodDaysSnapshot => _$this._noticePeriodDaysSnapshot;
  set noticePeriodDaysSnapshot(int? noticePeriodDaysSnapshot) =>
      _$this._noticePeriodDaysSnapshot = noticePeriodDaysSnapshot;

  DateTime? _noticeDueAt;
  DateTime? get noticeDueAt => _$this._noticeDueAt;
  set noticeDueAt(DateTime? noticeDueAt) => _$this._noticeDueAt = noticeDueAt;

  DateTime? _motionDeadlineAt;
  DateTime? get motionDeadlineAt => _$this._motionDeadlineAt;
  set motionDeadlineAt(DateTime? motionDeadlineAt) =>
      _$this._motionDeadlineAt = motionDeadlineAt;

  DateTime? _openedAt;
  DateTime? get openedAt => _$this._openedAt;
  set openedAt(DateTime? openedAt) => _$this._openedAt = openedAt;

  DateTime? _closedAt;
  DateTime? get closedAt => _$this._closedAt;
  set closedAt(DateTime? closedAt) => _$this._closedAt = closedAt;

  MeetingCancelReasonEnum? _cancelReason;
  MeetingCancelReasonEnum? get cancelReason => _$this._cancelReason;
  set cancelReason(MeetingCancelReasonEnum? cancelReason) =>
      _$this._cancelReason = cancelReason;

  MeetingBuilder() {
    Meeting._defaults(this);
  }

  MeetingBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _meetingId = $v.meetingId;
      _bodyId = $v.bodyId;
      _orgUnitId = $v.orgUnitId;
      _wahlperiodeId = $v.wahlperiodeId;
      _meetingNumber = $v.meetingNumber;
      _title = $v.title;
      _scheduledStart = $v.scheduledStart;
      _scheduledEnd = $v.scheduledEnd;
      _location = $v.location;
      _callLinkId = $v.callLinkId;
      _state = $v.state;
      _noticePeriodDaysSnapshot = $v.noticePeriodDaysSnapshot;
      _noticeDueAt = $v.noticeDueAt;
      _motionDeadlineAt = $v.motionDeadlineAt;
      _openedAt = $v.openedAt;
      _closedAt = $v.closedAt;
      _cancelReason = $v.cancelReason;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Meeting other) {
    _$v = other as _$Meeting;
  }

  @override
  void update(void Function(MeetingBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Meeting build() => _build();

  _$Meeting _build() {
    final _$result = _$v ??
        _$Meeting._(
          meetingId: BuiltValueNullFieldError.checkNotNull(
              meetingId, r'Meeting', 'meetingId'),
          bodyId: BuiltValueNullFieldError.checkNotNull(
              bodyId, r'Meeting', 'bodyId'),
          orgUnitId: orgUnitId,
          wahlperiodeId: wahlperiodeId,
          meetingNumber: meetingNumber,
          title:
              BuiltValueNullFieldError.checkNotNull(title, r'Meeting', 'title'),
          scheduledStart: BuiltValueNullFieldError.checkNotNull(
              scheduledStart, r'Meeting', 'scheduledStart'),
          scheduledEnd: scheduledEnd,
          location: location,
          callLinkId: callLinkId,
          state:
              BuiltValueNullFieldError.checkNotNull(state, r'Meeting', 'state'),
          noticePeriodDaysSnapshot: BuiltValueNullFieldError.checkNotNull(
              noticePeriodDaysSnapshot, r'Meeting', 'noticePeriodDaysSnapshot'),
          noticeDueAt: BuiltValueNullFieldError.checkNotNull(
              noticeDueAt, r'Meeting', 'noticeDueAt'),
          motionDeadlineAt: motionDeadlineAt,
          openedAt: openedAt,
          closedAt: closedAt,
          cancelReason: cancelReason,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
