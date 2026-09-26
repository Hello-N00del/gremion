// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'meeting_create.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MeetingCreate extends MeetingCreate {
  @override
  final String bodyId;
  @override
  final String? orgUnitId;
  @override
  final String? wahlperiodeId;
  @override
  final String title;
  @override
  final DateTime scheduledStart;
  @override
  final DateTime? scheduledEnd;
  @override
  final String? location;

  factory _$MeetingCreate([void Function(MeetingCreateBuilder)? updates]) =>
      (MeetingCreateBuilder()..update(updates))._build();

  _$MeetingCreate._(
      {required this.bodyId,
      this.orgUnitId,
      this.wahlperiodeId,
      required this.title,
      required this.scheduledStart,
      this.scheduledEnd,
      this.location})
      : super._();
  @override
  MeetingCreate rebuild(void Function(MeetingCreateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MeetingCreateBuilder toBuilder() => MeetingCreateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MeetingCreate &&
        bodyId == other.bodyId &&
        orgUnitId == other.orgUnitId &&
        wahlperiodeId == other.wahlperiodeId &&
        title == other.title &&
        scheduledStart == other.scheduledStart &&
        scheduledEnd == other.scheduledEnd &&
        location == other.location;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, wahlperiodeId.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, scheduledStart.hashCode);
    _$hash = $jc(_$hash, scheduledEnd.hashCode);
    _$hash = $jc(_$hash, location.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'MeetingCreate')
          ..add('bodyId', bodyId)
          ..add('orgUnitId', orgUnitId)
          ..add('wahlperiodeId', wahlperiodeId)
          ..add('title', title)
          ..add('scheduledStart', scheduledStart)
          ..add('scheduledEnd', scheduledEnd)
          ..add('location', location))
        .toString();
  }
}

class MeetingCreateBuilder
    implements Builder<MeetingCreate, MeetingCreateBuilder> {
  _$MeetingCreate? _$v;

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

  MeetingCreateBuilder() {
    MeetingCreate._defaults(this);
  }

  MeetingCreateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _bodyId = $v.bodyId;
      _orgUnitId = $v.orgUnitId;
      _wahlperiodeId = $v.wahlperiodeId;
      _title = $v.title;
      _scheduledStart = $v.scheduledStart;
      _scheduledEnd = $v.scheduledEnd;
      _location = $v.location;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MeetingCreate other) {
    _$v = other as _$MeetingCreate;
  }

  @override
  void update(void Function(MeetingCreateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MeetingCreate build() => _build();

  _$MeetingCreate _build() {
    final _$result = _$v ??
        _$MeetingCreate._(
          bodyId: BuiltValueNullFieldError.checkNotNull(
              bodyId, r'MeetingCreate', 'bodyId'),
          orgUnitId: orgUnitId,
          wahlperiodeId: wahlperiodeId,
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'MeetingCreate', 'title'),
          scheduledStart: BuiltValueNullFieldError.checkNotNull(
              scheduledStart, r'MeetingCreate', 'scheduledStart'),
          scheduledEnd: scheduledEnd,
          location: location,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
