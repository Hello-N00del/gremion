// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'notice_override.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$NoticeOverride extends NoticeOverride {
  @override
  final String overrideId;
  @override
  final String invitationId;
  @override
  final String meetingId;
  @override
  final String actorPersonId;
  @override
  final DateTime overriddenAt;
  @override
  final int daysShort;
  @override
  final String? reason;
  @override
  final String? curingBasisId;
  @override
  final int? curingBasisVersion;
  @override
  final String? curingBasisSnapshot;

  factory _$NoticeOverride([void Function(NoticeOverrideBuilder)? updates]) =>
      (NoticeOverrideBuilder()..update(updates))._build();

  _$NoticeOverride._(
      {required this.overrideId,
      required this.invitationId,
      required this.meetingId,
      required this.actorPersonId,
      required this.overriddenAt,
      required this.daysShort,
      this.reason,
      this.curingBasisId,
      this.curingBasisVersion,
      this.curingBasisSnapshot})
      : super._();
  @override
  NoticeOverride rebuild(void Function(NoticeOverrideBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  NoticeOverrideBuilder toBuilder() => NoticeOverrideBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is NoticeOverride &&
        overrideId == other.overrideId &&
        invitationId == other.invitationId &&
        meetingId == other.meetingId &&
        actorPersonId == other.actorPersonId &&
        overriddenAt == other.overriddenAt &&
        daysShort == other.daysShort &&
        reason == other.reason &&
        curingBasisId == other.curingBasisId &&
        curingBasisVersion == other.curingBasisVersion &&
        curingBasisSnapshot == other.curingBasisSnapshot;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, overrideId.hashCode);
    _$hash = $jc(_$hash, invitationId.hashCode);
    _$hash = $jc(_$hash, meetingId.hashCode);
    _$hash = $jc(_$hash, actorPersonId.hashCode);
    _$hash = $jc(_$hash, overriddenAt.hashCode);
    _$hash = $jc(_$hash, daysShort.hashCode);
    _$hash = $jc(_$hash, reason.hashCode);
    _$hash = $jc(_$hash, curingBasisId.hashCode);
    _$hash = $jc(_$hash, curingBasisVersion.hashCode);
    _$hash = $jc(_$hash, curingBasisSnapshot.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'NoticeOverride')
          ..add('overrideId', overrideId)
          ..add('invitationId', invitationId)
          ..add('meetingId', meetingId)
          ..add('actorPersonId', actorPersonId)
          ..add('overriddenAt', overriddenAt)
          ..add('daysShort', daysShort)
          ..add('reason', reason)
          ..add('curingBasisId', curingBasisId)
          ..add('curingBasisVersion', curingBasisVersion)
          ..add('curingBasisSnapshot', curingBasisSnapshot))
        .toString();
  }
}

class NoticeOverrideBuilder
    implements Builder<NoticeOverride, NoticeOverrideBuilder> {
  _$NoticeOverride? _$v;

  String? _overrideId;
  String? get overrideId => _$this._overrideId;
  set overrideId(String? overrideId) => _$this._overrideId = overrideId;

  String? _invitationId;
  String? get invitationId => _$this._invitationId;
  set invitationId(String? invitationId) => _$this._invitationId = invitationId;

  String? _meetingId;
  String? get meetingId => _$this._meetingId;
  set meetingId(String? meetingId) => _$this._meetingId = meetingId;

  String? _actorPersonId;
  String? get actorPersonId => _$this._actorPersonId;
  set actorPersonId(String? actorPersonId) =>
      _$this._actorPersonId = actorPersonId;

  DateTime? _overriddenAt;
  DateTime? get overriddenAt => _$this._overriddenAt;
  set overriddenAt(DateTime? overriddenAt) =>
      _$this._overriddenAt = overriddenAt;

  int? _daysShort;
  int? get daysShort => _$this._daysShort;
  set daysShort(int? daysShort) => _$this._daysShort = daysShort;

  String? _reason;
  String? get reason => _$this._reason;
  set reason(String? reason) => _$this._reason = reason;

  String? _curingBasisId;
  String? get curingBasisId => _$this._curingBasisId;
  set curingBasisId(String? curingBasisId) =>
      _$this._curingBasisId = curingBasisId;

  int? _curingBasisVersion;
  int? get curingBasisVersion => _$this._curingBasisVersion;
  set curingBasisVersion(int? curingBasisVersion) =>
      _$this._curingBasisVersion = curingBasisVersion;

  String? _curingBasisSnapshot;
  String? get curingBasisSnapshot => _$this._curingBasisSnapshot;
  set curingBasisSnapshot(String? curingBasisSnapshot) =>
      _$this._curingBasisSnapshot = curingBasisSnapshot;

  NoticeOverrideBuilder() {
    NoticeOverride._defaults(this);
  }

  NoticeOverrideBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _overrideId = $v.overrideId;
      _invitationId = $v.invitationId;
      _meetingId = $v.meetingId;
      _actorPersonId = $v.actorPersonId;
      _overriddenAt = $v.overriddenAt;
      _daysShort = $v.daysShort;
      _reason = $v.reason;
      _curingBasisId = $v.curingBasisId;
      _curingBasisVersion = $v.curingBasisVersion;
      _curingBasisSnapshot = $v.curingBasisSnapshot;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(NoticeOverride other) {
    _$v = other as _$NoticeOverride;
  }

  @override
  void update(void Function(NoticeOverrideBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  NoticeOverride build() => _build();

  _$NoticeOverride _build() {
    final _$result = _$v ??
        _$NoticeOverride._(
          overrideId: BuiltValueNullFieldError.checkNotNull(
              overrideId, r'NoticeOverride', 'overrideId'),
          invitationId: BuiltValueNullFieldError.checkNotNull(
              invitationId, r'NoticeOverride', 'invitationId'),
          meetingId: BuiltValueNullFieldError.checkNotNull(
              meetingId, r'NoticeOverride', 'meetingId'),
          actorPersonId: BuiltValueNullFieldError.checkNotNull(
              actorPersonId, r'NoticeOverride', 'actorPersonId'),
          overriddenAt: BuiltValueNullFieldError.checkNotNull(
              overriddenAt, r'NoticeOverride', 'overriddenAt'),
          daysShort: BuiltValueNullFieldError.checkNotNull(
              daysShort, r'NoticeOverride', 'daysShort'),
          reason: reason,
          curingBasisId: curingBasisId,
          curingBasisVersion: curingBasisVersion,
          curingBasisSnapshot: curingBasisSnapshot,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
