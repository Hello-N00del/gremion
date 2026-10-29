// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'membership.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const MembershipParticipationKindEnum
    _$membershipParticipationKindEnum_electedMember =
    const MembershipParticipationKindEnum._('electedMember');
const MembershipParticipationKindEnum
    _$membershipParticipationKindEnum_nonVotingHelper =
    const MembershipParticipationKindEnum._('nonVotingHelper');
const MembershipParticipationKindEnum
    _$membershipParticipationKindEnum_employee =
    const MembershipParticipationKindEnum._('employee');
const MembershipParticipationKindEnum
    _$membershipParticipationKindEnum_initiativeMember =
    const MembershipParticipationKindEnum._('initiativeMember');
const MembershipParticipationKindEnum
    _$membershipParticipationKindEnum_initiativeLead =
    const MembershipParticipationKindEnum._('initiativeLead');
const MembershipParticipationKindEnum
    _$membershipParticipationKindEnum_unknownDefaultOpenApi =
    const MembershipParticipationKindEnum._('unknownDefaultOpenApi');

MembershipParticipationKindEnum _$membershipParticipationKindEnumValueOf(
    String name) {
  switch (name) {
    case 'electedMember':
      return _$membershipParticipationKindEnum_electedMember;
    case 'nonVotingHelper':
      return _$membershipParticipationKindEnum_nonVotingHelper;
    case 'employee':
      return _$membershipParticipationKindEnum_employee;
    case 'initiativeMember':
      return _$membershipParticipationKindEnum_initiativeMember;
    case 'initiativeLead':
      return _$membershipParticipationKindEnum_initiativeLead;
    case 'unknownDefaultOpenApi':
      return _$membershipParticipationKindEnum_unknownDefaultOpenApi;
    default:
      return _$membershipParticipationKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MembershipParticipationKindEnum>
    _$membershipParticipationKindEnumValues = BuiltSet<
        MembershipParticipationKindEnum>(const <MembershipParticipationKindEnum>[
  _$membershipParticipationKindEnum_electedMember,
  _$membershipParticipationKindEnum_nonVotingHelper,
  _$membershipParticipationKindEnum_employee,
  _$membershipParticipationKindEnum_initiativeMember,
  _$membershipParticipationKindEnum_initiativeLead,
  _$membershipParticipationKindEnum_unknownDefaultOpenApi,
]);

const MembershipEndReasonEnum _$membershipEndReasonEnum_termEnd =
    const MembershipEndReasonEnum._('termEnd');
const MembershipEndReasonEnum _$membershipEndReasonEnum_resigned =
    const MembershipEndReasonEnum._('resigned');
const MembershipEndReasonEnum _$membershipEndReasonEnum_removed =
    const MembershipEndReasonEnum._('removed');
const MembershipEndReasonEnum _$membershipEndReasonEnum_dataCorrection =
    const MembershipEndReasonEnum._('dataCorrection');
const MembershipEndReasonEnum _$membershipEndReasonEnum_unknownDefaultOpenApi =
    const MembershipEndReasonEnum._('unknownDefaultOpenApi');

MembershipEndReasonEnum _$membershipEndReasonEnumValueOf(String name) {
  switch (name) {
    case 'termEnd':
      return _$membershipEndReasonEnum_termEnd;
    case 'resigned':
      return _$membershipEndReasonEnum_resigned;
    case 'removed':
      return _$membershipEndReasonEnum_removed;
    case 'dataCorrection':
      return _$membershipEndReasonEnum_dataCorrection;
    case 'unknownDefaultOpenApi':
      return _$membershipEndReasonEnum_unknownDefaultOpenApi;
    default:
      return _$membershipEndReasonEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MembershipEndReasonEnum> _$membershipEndReasonEnumValues =
    BuiltSet<MembershipEndReasonEnum>(const <MembershipEndReasonEnum>[
  _$membershipEndReasonEnum_termEnd,
  _$membershipEndReasonEnum_resigned,
  _$membershipEndReasonEnum_removed,
  _$membershipEndReasonEnum_dataCorrection,
  _$membershipEndReasonEnum_unknownDefaultOpenApi,
]);

const MembershipSource_Enum _$membershipSourceEnum_admin =
    const MembershipSource_Enum._('admin');
const MembershipSource_Enum _$membershipSourceEnum_controlPanel =
    const MembershipSource_Enum._('controlPanel');
const MembershipSource_Enum _$membershipSourceEnum_import_ =
    const MembershipSource_Enum._('import_');
const MembershipSource_Enum _$membershipSourceEnum_provisioning =
    const MembershipSource_Enum._('provisioning');
const MembershipSource_Enum _$membershipSourceEnum_unknownDefaultOpenApi =
    const MembershipSource_Enum._('unknownDefaultOpenApi');

MembershipSource_Enum _$membershipSourceEnumValueOf(String name) {
  switch (name) {
    case 'admin':
      return _$membershipSourceEnum_admin;
    case 'controlPanel':
      return _$membershipSourceEnum_controlPanel;
    case 'import_':
      return _$membershipSourceEnum_import_;
    case 'provisioning':
      return _$membershipSourceEnum_provisioning;
    case 'unknownDefaultOpenApi':
      return _$membershipSourceEnum_unknownDefaultOpenApi;
    default:
      return _$membershipSourceEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<MembershipSource_Enum> _$membershipSourceEnumValues =
    BuiltSet<MembershipSource_Enum>(const <MembershipSource_Enum>[
  _$membershipSourceEnum_admin,
  _$membershipSourceEnum_controlPanel,
  _$membershipSourceEnum_import_,
  _$membershipSourceEnum_provisioning,
  _$membershipSourceEnum_unknownDefaultOpenApi,
]);

Serializer<MembershipParticipationKindEnum>
    _$membershipParticipationKindEnumSerializer =
    _$MembershipParticipationKindEnumSerializer();
Serializer<MembershipEndReasonEnum> _$membershipEndReasonEnumSerializer =
    _$MembershipEndReasonEnumSerializer();
Serializer<MembershipSource_Enum> _$membershipSourceEnumSerializer =
    _$MembershipSource_EnumSerializer();

class _$MembershipParticipationKindEnumSerializer
    implements PrimitiveSerializer<MembershipParticipationKindEnum> {
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
  final Iterable<Type> types = const <Type>[MembershipParticipationKindEnum];
  @override
  final String wireName = 'MembershipParticipationKindEnum';

  @override
  Object serialize(
          Serializers serializers, MembershipParticipationKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MembershipParticipationKindEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MembershipParticipationKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$MembershipEndReasonEnumSerializer
    implements PrimitiveSerializer<MembershipEndReasonEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'termEnd': 'term_end',
    'resigned': 'resigned',
    'removed': 'removed',
    'dataCorrection': 'data_correction',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'term_end': 'termEnd',
    'resigned': 'resigned',
    'removed': 'removed',
    'data_correction': 'dataCorrection',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[MembershipEndReasonEnum];
  @override
  final String wireName = 'MembershipEndReasonEnum';

  @override
  Object serialize(Serializers serializers, MembershipEndReasonEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MembershipEndReasonEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MembershipEndReasonEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$MembershipSource_EnumSerializer
    implements PrimitiveSerializer<MembershipSource_Enum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'admin': 'admin',
    'controlPanel': 'control_panel',
    'import_': 'import',
    'provisioning': 'provisioning',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'admin': 'admin',
    'control_panel': 'controlPanel',
    'import': 'import_',
    'provisioning': 'provisioning',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[MembershipSource_Enum];
  @override
  final String wireName = 'MembershipSource_Enum';

  @override
  Object serialize(Serializers serializers, MembershipSource_Enum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  MembershipSource_Enum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      MembershipSource_Enum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Membership extends Membership {
  @override
  final String membershipId;
  @override
  final String personId;
  @override
  final String? orgUnitId;
  @override
  final MembershipParticipationKindEnum participationKind;
  @override
  final bool voting;
  @override
  final Date validFrom;
  @override
  final Date? validUntil;
  @override
  final String? wahlperiodeId;
  @override
  final MembershipEndReasonEnum? endReason;
  @override
  final MembershipSource_Enum source_;

  factory _$Membership([void Function(MembershipBuilder)? updates]) =>
      (MembershipBuilder()..update(updates))._build();

  _$Membership._(
      {required this.membershipId,
      required this.personId,
      this.orgUnitId,
      required this.participationKind,
      required this.voting,
      required this.validFrom,
      this.validUntil,
      this.wahlperiodeId,
      this.endReason,
      required this.source_})
      : super._();
  @override
  Membership rebuild(void Function(MembershipBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MembershipBuilder toBuilder() => MembershipBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Membership &&
        membershipId == other.membershipId &&
        personId == other.personId &&
        orgUnitId == other.orgUnitId &&
        participationKind == other.participationKind &&
        voting == other.voting &&
        validFrom == other.validFrom &&
        validUntil == other.validUntil &&
        wahlperiodeId == other.wahlperiodeId &&
        endReason == other.endReason &&
        source_ == other.source_;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, membershipId.hashCode);
    _$hash = $jc(_$hash, personId.hashCode);
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, participationKind.hashCode);
    _$hash = $jc(_$hash, voting.hashCode);
    _$hash = $jc(_$hash, validFrom.hashCode);
    _$hash = $jc(_$hash, validUntil.hashCode);
    _$hash = $jc(_$hash, wahlperiodeId.hashCode);
    _$hash = $jc(_$hash, endReason.hashCode);
    _$hash = $jc(_$hash, source_.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Membership')
          ..add('membershipId', membershipId)
          ..add('personId', personId)
          ..add('orgUnitId', orgUnitId)
          ..add('participationKind', participationKind)
          ..add('voting', voting)
          ..add('validFrom', validFrom)
          ..add('validUntil', validUntil)
          ..add('wahlperiodeId', wahlperiodeId)
          ..add('endReason', endReason)
          ..add('source_', source_))
        .toString();
  }
}

class MembershipBuilder implements Builder<Membership, MembershipBuilder> {
  _$Membership? _$v;

  String? _membershipId;
  String? get membershipId => _$this._membershipId;
  set membershipId(String? membershipId) => _$this._membershipId = membershipId;

  String? _personId;
  String? get personId => _$this._personId;
  set personId(String? personId) => _$this._personId = personId;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  MembershipParticipationKindEnum? _participationKind;
  MembershipParticipationKindEnum? get participationKind =>
      _$this._participationKind;
  set participationKind(MembershipParticipationKindEnum? participationKind) =>
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

  MembershipEndReasonEnum? _endReason;
  MembershipEndReasonEnum? get endReason => _$this._endReason;
  set endReason(MembershipEndReasonEnum? endReason) =>
      _$this._endReason = endReason;

  MembershipSource_Enum? _source_;
  MembershipSource_Enum? get source_ => _$this._source_;
  set source_(MembershipSource_Enum? source_) => _$this._source_ = source_;

  MembershipBuilder() {
    Membership._defaults(this);
  }

  MembershipBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _membershipId = $v.membershipId;
      _personId = $v.personId;
      _orgUnitId = $v.orgUnitId;
      _participationKind = $v.participationKind;
      _voting = $v.voting;
      _validFrom = $v.validFrom;
      _validUntil = $v.validUntil;
      _wahlperiodeId = $v.wahlperiodeId;
      _endReason = $v.endReason;
      _source_ = $v.source_;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Membership other) {
    _$v = other as _$Membership;
  }

  @override
  void update(void Function(MembershipBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Membership build() => _build();

  _$Membership _build() {
    final _$result = _$v ??
        _$Membership._(
          membershipId: BuiltValueNullFieldError.checkNotNull(
              membershipId, r'Membership', 'membershipId'),
          personId: BuiltValueNullFieldError.checkNotNull(
              personId, r'Membership', 'personId'),
          orgUnitId: orgUnitId,
          participationKind: BuiltValueNullFieldError.checkNotNull(
              participationKind, r'Membership', 'participationKind'),
          voting: BuiltValueNullFieldError.checkNotNull(
              voting, r'Membership', 'voting'),
          validFrom: BuiltValueNullFieldError.checkNotNull(
              validFrom, r'Membership', 'validFrom'),
          validUntil: validUntil,
          wahlperiodeId: wahlperiodeId,
          endReason: endReason,
          source_: BuiltValueNullFieldError.checkNotNull(
              source_, r'Membership', 'source_'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
