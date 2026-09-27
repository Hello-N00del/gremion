// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_recipient.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const InvitationRecipientDeliveryStateEnum
    _$invitationRecipientDeliveryStateEnum_queued =
    const InvitationRecipientDeliveryStateEnum._('queued');
const InvitationRecipientDeliveryStateEnum
    _$invitationRecipientDeliveryStateEnum_submitted =
    const InvitationRecipientDeliveryStateEnum._('submitted');
const InvitationRecipientDeliveryStateEnum
    _$invitationRecipientDeliveryStateEnum_failed =
    const InvitationRecipientDeliveryStateEnum._('failed');
const InvitationRecipientDeliveryStateEnum
    _$invitationRecipientDeliveryStateEnum_bounced =
    const InvitationRecipientDeliveryStateEnum._('bounced');
const InvitationRecipientDeliveryStateEnum
    _$invitationRecipientDeliveryStateEnum_noConnector =
    const InvitationRecipientDeliveryStateEnum._('noConnector');
const InvitationRecipientDeliveryStateEnum
    _$invitationRecipientDeliveryStateEnum_unknownDefaultOpenApi =
    const InvitationRecipientDeliveryStateEnum._('unknownDefaultOpenApi');

InvitationRecipientDeliveryStateEnum
    _$invitationRecipientDeliveryStateEnumValueOf(String name) {
  switch (name) {
    case 'queued':
      return _$invitationRecipientDeliveryStateEnum_queued;
    case 'submitted':
      return _$invitationRecipientDeliveryStateEnum_submitted;
    case 'failed':
      return _$invitationRecipientDeliveryStateEnum_failed;
    case 'bounced':
      return _$invitationRecipientDeliveryStateEnum_bounced;
    case 'noConnector':
      return _$invitationRecipientDeliveryStateEnum_noConnector;
    case 'unknownDefaultOpenApi':
      return _$invitationRecipientDeliveryStateEnum_unknownDefaultOpenApi;
    default:
      return _$invitationRecipientDeliveryStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<InvitationRecipientDeliveryStateEnum>
    _$invitationRecipientDeliveryStateEnumValues = BuiltSet<
        InvitationRecipientDeliveryStateEnum>(const <InvitationRecipientDeliveryStateEnum>[
  _$invitationRecipientDeliveryStateEnum_queued,
  _$invitationRecipientDeliveryStateEnum_submitted,
  _$invitationRecipientDeliveryStateEnum_failed,
  _$invitationRecipientDeliveryStateEnum_bounced,
  _$invitationRecipientDeliveryStateEnum_noConnector,
  _$invitationRecipientDeliveryStateEnum_unknownDefaultOpenApi,
]);

Serializer<InvitationRecipientDeliveryStateEnum>
    _$invitationRecipientDeliveryStateEnumSerializer =
    _$InvitationRecipientDeliveryStateEnumSerializer();

class _$InvitationRecipientDeliveryStateEnumSerializer
    implements PrimitiveSerializer<InvitationRecipientDeliveryStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'queued': 'queued',
    'submitted': 'submitted',
    'failed': 'failed',
    'bounced': 'bounced',
    'noConnector': 'no_connector',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'queued': 'queued',
    'submitted': 'submitted',
    'failed': 'failed',
    'bounced': 'bounced',
    'no_connector': 'noConnector',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[
    InvitationRecipientDeliveryStateEnum
  ];
  @override
  final String wireName = 'InvitationRecipientDeliveryStateEnum';

  @override
  Object serialize(
          Serializers serializers, InvitationRecipientDeliveryStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  InvitationRecipientDeliveryStateEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      InvitationRecipientDeliveryStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$InvitationRecipient extends InvitationRecipient {
  @override
  final String recipientId;
  @override
  final String invitationId;
  @override
  final String personId;
  @override
  final InvitationRecipientDeliveryStateEnum deliveryState;
  @override
  final String? bounceClass;
  @override
  final DateTime? submittedAt;
  @override
  final bool? inAppDelivered;

  factory _$InvitationRecipient(
          [void Function(InvitationRecipientBuilder)? updates]) =>
      (InvitationRecipientBuilder()..update(updates))._build();

  _$InvitationRecipient._(
      {required this.recipientId,
      required this.invitationId,
      required this.personId,
      required this.deliveryState,
      this.bounceClass,
      this.submittedAt,
      this.inAppDelivered})
      : super._();
  @override
  InvitationRecipient rebuild(
          void Function(InvitationRecipientBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  InvitationRecipientBuilder toBuilder() =>
      InvitationRecipientBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is InvitationRecipient &&
        recipientId == other.recipientId &&
        invitationId == other.invitationId &&
        personId == other.personId &&
        deliveryState == other.deliveryState &&
        bounceClass == other.bounceClass &&
        submittedAt == other.submittedAt &&
        inAppDelivered == other.inAppDelivered;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, recipientId.hashCode);
    _$hash = $jc(_$hash, invitationId.hashCode);
    _$hash = $jc(_$hash, personId.hashCode);
    _$hash = $jc(_$hash, deliveryState.hashCode);
    _$hash = $jc(_$hash, bounceClass.hashCode);
    _$hash = $jc(_$hash, submittedAt.hashCode);
    _$hash = $jc(_$hash, inAppDelivered.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'InvitationRecipient')
          ..add('recipientId', recipientId)
          ..add('invitationId', invitationId)
          ..add('personId', personId)
          ..add('deliveryState', deliveryState)
          ..add('bounceClass', bounceClass)
          ..add('submittedAt', submittedAt)
          ..add('inAppDelivered', inAppDelivered))
        .toString();
  }
}

class InvitationRecipientBuilder
    implements Builder<InvitationRecipient, InvitationRecipientBuilder> {
  _$InvitationRecipient? _$v;

  String? _recipientId;
  String? get recipientId => _$this._recipientId;
  set recipientId(String? recipientId) => _$this._recipientId = recipientId;

  String? _invitationId;
  String? get invitationId => _$this._invitationId;
  set invitationId(String? invitationId) => _$this._invitationId = invitationId;

  String? _personId;
  String? get personId => _$this._personId;
  set personId(String? personId) => _$this._personId = personId;

  InvitationRecipientDeliveryStateEnum? _deliveryState;
  InvitationRecipientDeliveryStateEnum? get deliveryState =>
      _$this._deliveryState;
  set deliveryState(InvitationRecipientDeliveryStateEnum? deliveryState) =>
      _$this._deliveryState = deliveryState;

  String? _bounceClass;
  String? get bounceClass => _$this._bounceClass;
  set bounceClass(String? bounceClass) => _$this._bounceClass = bounceClass;

  DateTime? _submittedAt;
  DateTime? get submittedAt => _$this._submittedAt;
  set submittedAt(DateTime? submittedAt) => _$this._submittedAt = submittedAt;

  bool? _inAppDelivered;
  bool? get inAppDelivered => _$this._inAppDelivered;
  set inAppDelivered(bool? inAppDelivered) =>
      _$this._inAppDelivered = inAppDelivered;

  InvitationRecipientBuilder() {
    InvitationRecipient._defaults(this);
  }

  InvitationRecipientBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _recipientId = $v.recipientId;
      _invitationId = $v.invitationId;
      _personId = $v.personId;
      _deliveryState = $v.deliveryState;
      _bounceClass = $v.bounceClass;
      _submittedAt = $v.submittedAt;
      _inAppDelivered = $v.inAppDelivered;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(InvitationRecipient other) {
    _$v = other as _$InvitationRecipient;
  }

  @override
  void update(void Function(InvitationRecipientBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  InvitationRecipient build() => _build();

  _$InvitationRecipient _build() {
    final _$result = _$v ??
        _$InvitationRecipient._(
          recipientId: BuiltValueNullFieldError.checkNotNull(
              recipientId, r'InvitationRecipient', 'recipientId'),
          invitationId: BuiltValueNullFieldError.checkNotNull(
              invitationId, r'InvitationRecipient', 'invitationId'),
          personId: BuiltValueNullFieldError.checkNotNull(
              personId, r'InvitationRecipient', 'personId'),
          deliveryState: BuiltValueNullFieldError.checkNotNull(
              deliveryState, r'InvitationRecipient', 'deliveryState'),
          bounceClass: bounceClass,
          submittedAt: submittedAt,
          inAppDelivered: inAppDelivered,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
