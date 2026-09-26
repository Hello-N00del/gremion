// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'meeting_update.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MeetingUpdate extends MeetingUpdate {
  @override
  final String? title;
  @override
  final DateTime? scheduledStart;
  @override
  final DateTime? scheduledEnd;
  @override
  final String? location;

  factory _$MeetingUpdate([void Function(MeetingUpdateBuilder)? updates]) =>
      (MeetingUpdateBuilder()..update(updates))._build();

  _$MeetingUpdate._(
      {this.title, this.scheduledStart, this.scheduledEnd, this.location})
      : super._();
  @override
  MeetingUpdate rebuild(void Function(MeetingUpdateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MeetingUpdateBuilder toBuilder() => MeetingUpdateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MeetingUpdate &&
        title == other.title &&
        scheduledStart == other.scheduledStart &&
        scheduledEnd == other.scheduledEnd &&
        location == other.location;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, scheduledStart.hashCode);
    _$hash = $jc(_$hash, scheduledEnd.hashCode);
    _$hash = $jc(_$hash, location.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'MeetingUpdate')
          ..add('title', title)
          ..add('scheduledStart', scheduledStart)
          ..add('scheduledEnd', scheduledEnd)
          ..add('location', location))
        .toString();
  }
}

class MeetingUpdateBuilder
    implements Builder<MeetingUpdate, MeetingUpdateBuilder> {
  _$MeetingUpdate? _$v;

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

  MeetingUpdateBuilder() {
    MeetingUpdate._defaults(this);
  }

  MeetingUpdateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _title = $v.title;
      _scheduledStart = $v.scheduledStart;
      _scheduledEnd = $v.scheduledEnd;
      _location = $v.location;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MeetingUpdate other) {
    _$v = other as _$MeetingUpdate;
  }

  @override
  void update(void Function(MeetingUpdateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MeetingUpdate build() => _build();

  _$MeetingUpdate _build() {
    final _$result = _$v ??
        _$MeetingUpdate._(
          title: title,
          scheduledStart: scheduledStart,
          scheduledEnd: scheduledEnd,
          location: location,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
