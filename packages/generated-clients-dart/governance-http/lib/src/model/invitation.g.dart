// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const InvitationStateEnum _$invitationStateEnum_draft =
    const InvitationStateEnum._('draft');
const InvitationStateEnum _$invitationStateEnum_checked =
    const InvitationStateEnum._('checked');
const InvitationStateEnum _$invitationStateEnum_blocked =
    const InvitationStateEnum._('blocked');
const InvitationStateEnum _$invitationStateEnum_overrideLogged =
    const InvitationStateEnum._('overrideLogged');
const InvitationStateEnum _$invitationStateEnum_dispatching =
    const InvitationStateEnum._('dispatching');
const InvitationStateEnum _$invitationStateEnum_dispatchRefused =
    const InvitationStateEnum._('dispatchRefused');
const InvitationStateEnum _$invitationStateEnum_sent =
    const InvitationStateEnum._('sent');
const InvitationStateEnum _$invitationStateEnum_partlyFailed =
    const InvitationStateEnum._('partlyFailed');
const InvitationStateEnum _$invitationStateEnum_unknownDefaultOpenApi =
    const InvitationStateEnum._('unknownDefaultOpenApi');

InvitationStateEnum _$invitationStateEnumValueOf(String name) {
  switch (name) {
    case 'draft':
      return _$invitationStateEnum_draft;
    case 'checked':
      return _$invitationStateEnum_checked;
    case 'blocked':
      return _$invitationStateEnum_blocked;
    case 'overrideLogged':
      return _$invitationStateEnum_overrideLogged;
    case 'dispatching':
      return _$invitationStateEnum_dispatching;
    case 'dispatchRefused':
      return _$invitationStateEnum_dispatchRefused;
    case 'sent':
      return _$invitationStateEnum_sent;
    case 'partlyFailed':
      return _$invitationStateEnum_partlyFailed;
    case 'unknownDefaultOpenApi':
      return _$invitationStateEnum_unknownDefaultOpenApi;
    default:
      return _$invitationStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<InvitationStateEnum> _$invitationStateEnumValues =
    BuiltSet<InvitationStateEnum>(const <InvitationStateEnum>[
  _$invitationStateEnum_draft,
  _$invitationStateEnum_checked,
  _$invitationStateEnum_blocked,
  _$invitationStateEnum_overrideLogged,
  _$invitationStateEnum_dispatching,
  _$invitationStateEnum_dispatchRefused,
  _$invitationStateEnum_sent,
  _$invitationStateEnum_partlyFailed,
  _$invitationStateEnum_unknownDefaultOpenApi,
]);

Serializer<InvitationStateEnum> _$invitationStateEnumSerializer =
    _$InvitationStateEnumSerializer();

class _$InvitationStateEnumSerializer
    implements PrimitiveSerializer<InvitationStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'draft': 'draft',
    'checked': 'checked',
    'blocked': 'blocked',
    'overrideLogged': 'override_logged',
    'dispatching': 'dispatching',
    'dispatchRefused': 'dispatch_refused',
    'sent': 'sent',
    'partlyFailed': 'partly_failed',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'draft': 'draft',
    'checked': 'checked',
    'blocked': 'blocked',
    'override_logged': 'overrideLogged',
    'dispatching': 'dispatching',
    'dispatch_refused': 'dispatchRefused',
    'sent': 'sent',
    'partly_failed': 'partlyFailed',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[InvitationStateEnum];
  @override
  final String wireName = 'InvitationStateEnum';

  @override
  Object serialize(Serializers serializers, InvitationStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  InvitationStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      InvitationStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Invitation extends Invitation {
  @override
  final String invitationId;
  @override
  final String meetingId;
  @override
  final int version;
  @override
  final String? agendaSnapshotId;
  @override
  final InvitationStateEnum state;
  @override
  final bool? noticeMet;
  @override
  final DateTime? sentAt;
  @override
  final String? senderPersonId;
  @override
  final int? recipientCount;

  factory _$Invitation([void Function(InvitationBuilder)? updates]) =>
      (InvitationBuilder()..update(updates))._build();

  _$Invitation._(
      {required this.invitationId,
      required this.meetingId,
      required this.version,
      this.agendaSnapshotId,
      required this.state,
      this.noticeMet,
      this.sentAt,
      this.senderPersonId,
      this.recipientCount})
      : super._();
  @override
  Invitation rebuild(void Function(InvitationBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  InvitationBuilder toBuilder() => InvitationBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Invitation &&
        invitationId == other.invitationId &&
        meetingId == other.meetingId &&
        version == other.version &&
        agendaSnapshotId == other.agendaSnapshotId &&
        state == other.state &&
        noticeMet == other.noticeMet &&
        sentAt == other.sentAt &&
        senderPersonId == other.senderPersonId &&
        recipientCount == other.recipientCount;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, invitationId.hashCode);
    _$hash = $jc(_$hash, meetingId.hashCode);
    _$hash = $jc(_$hash, version.hashCode);
    _$hash = $jc(_$hash, agendaSnapshotId.hashCode);
    _$hash = $jc(_$hash, state.hashCode);
    _$hash = $jc(_$hash, noticeMet.hashCode);
    _$hash = $jc(_$hash, sentAt.hashCode);
    _$hash = $jc(_$hash, senderPersonId.hashCode);
    _$hash = $jc(_$hash, recipientCount.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Invitation')
          ..add('invitationId', invitationId)
          ..add('meetingId', meetingId)
          ..add('version', version)
          ..add('agendaSnapshotId', agendaSnapshotId)
          ..add('state', state)
          ..add('noticeMet', noticeMet)
          ..add('sentAt', sentAt)
          ..add('senderPersonId', senderPersonId)
          ..add('recipientCount', recipientCount))
        .toString();
  }
}

class InvitationBuilder implements Builder<Invitation, InvitationBuilder> {
  _$Invitation? _$v;

  String? _invitationId;
  String? get invitationId => _$this._invitationId;
  set invitationId(String? invitationId) => _$this._invitationId = invitationId;

  String? _meetingId;
  String? get meetingId => _$this._meetingId;
  set meetingId(String? meetingId) => _$this._meetingId = meetingId;

  int? _version;
  int? get version => _$this._version;
  set version(int? version) => _$this._version = version;

  String? _agendaSnapshotId;
  String? get agendaSnapshotId => _$this._agendaSnapshotId;
  set agendaSnapshotId(String? agendaSnapshotId) =>
      _$this._agendaSnapshotId = agendaSnapshotId;

  InvitationStateEnum? _state;
  InvitationStateEnum? get state => _$this._state;
  set state(InvitationStateEnum? state) => _$this._state = state;

  bool? _noticeMet;
  bool? get noticeMet => _$this._noticeMet;
  set noticeMet(bool? noticeMet) => _$this._noticeMet = noticeMet;

  DateTime? _sentAt;
  DateTime? get sentAt => _$this._sentAt;
  set sentAt(DateTime? sentAt) => _$this._sentAt = sentAt;

  String? _senderPersonId;
  String? get senderPersonId => _$this._senderPersonId;
  set senderPersonId(String? senderPersonId) =>
      _$this._senderPersonId = senderPersonId;

  int? _recipientCount;
  int? get recipientCount => _$this._recipientCount;
  set recipientCount(int? recipientCount) =>
      _$this._recipientCount = recipientCount;

  InvitationBuilder() {
    Invitation._defaults(this);
  }

  InvitationBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _invitationId = $v.invitationId;
      _meetingId = $v.meetingId;
      _version = $v.version;
      _agendaSnapshotId = $v.agendaSnapshotId;
      _state = $v.state;
      _noticeMet = $v.noticeMet;
      _sentAt = $v.sentAt;
      _senderPersonId = $v.senderPersonId;
      _recipientCount = $v.recipientCount;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Invitation other) {
    _$v = other as _$Invitation;
  }

  @override
  void update(void Function(InvitationBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Invitation build() => _build();

  _$Invitation _build() {
    final _$result = _$v ??
        _$Invitation._(
          invitationId: BuiltValueNullFieldError.checkNotNull(
              invitationId, r'Invitation', 'invitationId'),
          meetingId: BuiltValueNullFieldError.checkNotNull(
              meetingId, r'Invitation', 'meetingId'),
          version: BuiltValueNullFieldError.checkNotNull(
              version, r'Invitation', 'version'),
          agendaSnapshotId: agendaSnapshotId,
          state: BuiltValueNullFieldError.checkNotNull(
              state, r'Invitation', 'state'),
          noticeMet: noticeMet,
          sentAt: sentAt,
          senderPersonId: senderPersonId,
          recipientCount: recipientCount,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
