// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'start_membership.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const StartMembershipParticipationKindEnum
    _$startMembershipParticipationKindEnum_electedMember =
    const StartMembershipParticipationKindEnum._('electedMember');
const StartMembershipParticipationKindEnum
    _$startMembershipParticipationKindEnum_nonVotingHelper =
    const StartMembershipParticipationKindEnum._('nonVotingHelper');
const StartMembershipParticipationKindEnum
    _$startMembershipParticipationKindEnum_employee =
    const StartMembershipParticipationKindEnum._('employee');
const StartMembershipParticipationKindEnum
    _$startMembershipParticipationKindEnum_initiativeMember =
    const StartMembershipParticipationKindEnum._('initiativeMember');
const StartMembershipParticipationKindEnum
    _$startMembershipParticipationKindEnum_initiativeLead =
    const StartMembershipParticipationKindEnum._('initiativeLead');
const StartMembershipParticipationKindEnum
    _$startMembershipParticipationKindEnum_unknownDefaultOpenApi =
    const StartMembershipParticipationKindEnum._('unknownDefaultOpenApi');

StartMembershipParticipationKindEnum
    _$startMembershipParticipationKindEnumValueOf(String name) {
  switch (name) {
    case 'electedMember':
      return _$startMembershipParticipationKindEnum_electedMember;
    case 'nonVotingHelper':
      return _$startMembershipParticipationKindEnum_nonVotingHelper;
    case 'employee':
      return _$startMembershipParticipationKindEnum_employee;
    case 'initiativeMember':
      return _$startMembershipParticipationKindEnum_initiativeMember;
    case 'initiativeLead':
      return _$startMembershipParticipationKindEnum_initiativeLead;
    case 'unknownDefaultOpenApi':
      return _$startMembershipParticipationKindEnum_unknownDefaultOpenApi;
    default:
      return _$startMembershipParticipationKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<StartMembershipParticipationKindEnum>
    _$startMembershipParticipationKindEnumValues = BuiltSet<
        StartMembershipParticipationKindEnum>(const <StartMembershipParticipationKindEnum>[
  _$startMembershipParticipationKindEnum_electedMember,
  _$startMembershipParticipationKindEnum_nonVotingHelper,
  _$startMembershipParticipationKindEnum_employee,
  _$startMembershipParticipationKindEnum_initiativeMember,
  _$startMembershipParticipationKindEnum_initiativeLead,
  _$startMembershipParticipationKindEnum_unknownDefaultOpenApi,
]);

Serializer<StartMembershipParticipationKindEnum>
    _$startMembershipParticipationKindEnumSerializer =
    _$StartMembershipParticipationKindEnumSerializer();

class _$StartMembershipParticipationKindEnumSerializer
    implements PrimitiveSerializer<StartMembershipParticipationKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'electedMember': 'elected_member',
    'nonVotingHelper': 'non_voting_helper',
    'employee': 'employee',
    'initiativeMember': 'initiative_member',
    'initiativeLead': 'initiative_lead',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'elected_member': 'electedMember',
    'non_voting_helper': 'nonVotingHelper',
    'employee': 'employee',
    'initiative_member': 'initiativeMember',
    'initiative_lead': 'initiativeLead',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[
    StartMembershipParticipationKindEnum
  ];
  @override
  final String wireName = 'StartMembershipParticipationKindEnum';

  @override
  Object serialize(
          Serializers serializers, StartMembershipParticipationKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  StartMembershipParticipationKindEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      StartMembershipParticipationKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$StartMembership extends StartMembership {
  @override
  final String personId;
  @override
  final String? orgUnitId;
  @override
  final StartMembershipParticipationKindEnum participationKind;
  @override
  final bool voting;
  @override
  final Date validFrom;
  @override
  final Date? validUntil;
  @override
  final String? wahlperiodeId;

  factory _$StartMembership([void Function(StartMembershipBuilder)? updates]) =>
      (StartMembershipBuilder()..update(updates))._build();

  _$StartMembership._(
      {required this.personId,
      this.orgUnitId,
      required this.participationKind,
      required this.voting,
      required this.validFrom,
      this.validUntil,
      this.wahlperiodeId})
      : super._();
  @override
  StartMembership rebuild(void Function(StartMembershipBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  StartMembershipBuilder toBuilder() => StartMembershipBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is StartMembership &&
        personId == other.personId &&
        orgUnitId == other.orgUnitId &&
        participationKind == other.participationKind &&
        voting == other.voting &&
        validFrom == other.validFrom &&
        validUntil == other.validUntil &&
        wahlperiodeId == other.wahlperiodeId;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, personId.hashCode);
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, participationKind.hashCode);
    _$hash = $jc(_$hash, voting.hashCode);
    _$hash = $jc(_$hash, validFrom.hashCode);
    _$hash = $jc(_$hash, validUntil.hashCode);
    _$hash = $jc(_$hash, wahlperiodeId.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'StartMembership')
          ..add('personId', personId)
          ..add('orgUnitId', orgUnitId)
          ..add('participationKind', participationKind)
          ..add('voting', voting)
          ..add('validFrom', validFrom)
          ..add('validUntil', validUntil)
          ..add('wahlperiodeId', wahlperiodeId))
        .toString();
  }
}

class StartMembershipBuilder
    implements Builder<StartMembership, StartMembershipBuilder> {
  _$StartMembership? _$v;

  String? _personId;
  String? get personId => _$this._personId;
  set personId(String? personId) => _$this._personId = personId;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  StartMembershipParticipationKindEnum? _participationKind;
  StartMembershipParticipationKindEnum? get participationKind =>
      _$this._participationKind;
  set participationKind(
          StartMembershipParticipationKindEnum? participationKind) =>
      _$this._participationKind = participationKind;

  bool? _voting;
  bool? get voting => _$this._voting;
  set voting(bool? voting) => _$this._voting = voting;

  Date? _validFrom;
  Date? get validFrom => _$this._validFrom;
  set validFrom(Date? validFrom) => _$this._validFrom = validFrom;

  Date? _validUntil;
  Date? get validUntil => _$this._validUntil;
  set validUntil(Date? validUntil) => _$this._validUntil = validUntil;

  String? _wahlperiodeId;
  String? get wahlperiodeId => _$this._wahlperiodeId;
  set wahlperiodeId(String? wahlperiodeId) =>
      _$this._wahlperiodeId = wahlperiodeId;

  StartMembershipBuilder() {
    StartMembership._defaults(this);
  }

  StartMembershipBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _personId = $v.personId;
      _orgUnitId = $v.orgUnitId;
      _participationKind = $v.participationKind;
      _voting = $v.voting;
      _validFrom = $v.validFrom;
      _validUntil = $v.validUntil;
      _wahlperiodeId = $v.wahlperiodeId;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(StartMembership other) {
    _$v = other as _$StartMembership;
  }

  @override
  void update(void Function(StartMembershipBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  StartMembership build() => _build();

  _$StartMembership _build() {
    final _$result = _$v ??
        _$StartMembership._(
          personId: BuiltValueNullFieldError.checkNotNull(
              personId, r'StartMembership', 'personId'),
          orgUnitId: orgUnitId,
          participationKind: BuiltValueNullFieldError.checkNotNull(
              participationKind, r'StartMembership', 'participationKind'),
          voting: BuiltValueNullFieldError.checkNotNull(
              voting, r'StartMembership', 'voting'),
          validFrom: BuiltValueNullFieldError.checkNotNull(
              validFrom, r'StartMembership', 'validFrom'),
          validUntil: validUntil,
          wahlperiodeId: wahlperiodeId,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
