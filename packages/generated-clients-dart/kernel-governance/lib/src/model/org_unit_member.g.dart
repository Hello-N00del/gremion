// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'org_unit_member.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const OrgUnitMemberMembershipTypeEnum
    _$orgUnitMemberMembershipTypeEnum_elected =
    const OrgUnitMemberMembershipTypeEnum._('elected');
const OrgUnitMemberMembershipTypeEnum
    _$orgUnitMemberMembershipTypeEnum_unelected =
    const OrgUnitMemberMembershipTypeEnum._('unelected');
const OrgUnitMemberMembershipTypeEnum
    _$orgUnitMemberMembershipTypeEnum_employee =
    const OrgUnitMemberMembershipTypeEnum._('employee');
const OrgUnitMemberMembershipTypeEnum
    _$orgUnitMemberMembershipTypeEnum_unknownDefaultOpenApi =
    const OrgUnitMemberMembershipTypeEnum._('unknownDefaultOpenApi');

OrgUnitMemberMembershipTypeEnum _$orgUnitMemberMembershipTypeEnumValueOf(
    String name) {
  switch (name) {
    case 'elected':
      return _$orgUnitMemberMembershipTypeEnum_elected;
    case 'unelected':
      return _$orgUnitMemberMembershipTypeEnum_unelected;
    case 'employee':
      return _$orgUnitMemberMembershipTypeEnum_employee;
    case 'unknownDefaultOpenApi':
      return _$orgUnitMemberMembershipTypeEnum_unknownDefaultOpenApi;
    default:
      return _$orgUnitMemberMembershipTypeEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<OrgUnitMemberMembershipTypeEnum>
    _$orgUnitMemberMembershipTypeEnumValues = BuiltSet<
        OrgUnitMemberMembershipTypeEnum>(const <OrgUnitMemberMembershipTypeEnum>[
  _$orgUnitMemberMembershipTypeEnum_elected,
  _$orgUnitMemberMembershipTypeEnum_unelected,
  _$orgUnitMemberMembershipTypeEnum_employee,
  _$orgUnitMemberMembershipTypeEnum_unknownDefaultOpenApi,
]);

Serializer<OrgUnitMemberMembershipTypeEnum>
    _$orgUnitMemberMembershipTypeEnumSerializer =
    _$OrgUnitMemberMembershipTypeEnumSerializer();

class _$OrgUnitMemberMembershipTypeEnumSerializer
    implements PrimitiveSerializer<OrgUnitMemberMembershipTypeEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'elected': 'elected',
    'unelected': 'unelected',
    'employee': 'employee',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'elected': 'elected',
    'unelected': 'unelected',
    'employee': 'employee',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[OrgUnitMemberMembershipTypeEnum];
  @override
  final String wireName = 'OrgUnitMemberMembershipTypeEnum';

  @override
  Object serialize(
          Serializers serializers, OrgUnitMemberMembershipTypeEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  OrgUnitMemberMembershipTypeEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      OrgUnitMemberMembershipTypeEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

abstract class OrgUnitMemberBuilder {
  void replace(OrgUnitMember other);
  void update(void Function(OrgUnitMemberBuilder) updates);
  String? get id;
  set id(String? id);

  String? get orgUnitId;
  set orgUnitId(String? orgUnitId);

  String? get userKeycloakId;
  set userKeycloakId(String? userKeycloakId);

  OrgUnitMemberMembershipTypeEnum? get membershipType;
  set membershipType(OrgUnitMemberMembershipTypeEnum? membershipType);

  Date? get termStart;
  set termStart(Date? termStart);

  Date? get termEnd;
  set termEnd(Date? termEnd);

  bool? get voting;
  set voting(bool? voting);

  DateTime? get joinedAt;
  set joinedAt(DateTime? joinedAt);
}

class _$$OrgUnitMember extends $OrgUnitMember {
  @override
  final String id;
  @override
  final String orgUnitId;
  @override
  final String userKeycloakId;
  @override
  final OrgUnitMemberMembershipTypeEnum membershipType;
  @override
  final Date? termStart;
  @override
  final Date? termEnd;
  @override
  final bool voting;
  @override
  final DateTime joinedAt;

  factory _$$OrgUnitMember([void Function($OrgUnitMemberBuilder)? updates]) =>
      ($OrgUnitMemberBuilder()..update(updates))._build();

  _$$OrgUnitMember._(
      {required this.id,
      required this.orgUnitId,
      required this.userKeycloakId,
      required this.membershipType,
      this.termStart,
      this.termEnd,
      required this.voting,
      required this.joinedAt})
      : super._();
  @override
  $OrgUnitMember rebuild(void Function($OrgUnitMemberBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  $OrgUnitMemberBuilder toBuilder() => $OrgUnitMemberBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is $OrgUnitMember &&
        id == other.id &&
        orgUnitId == other.orgUnitId &&
        userKeycloakId == other.userKeycloakId &&
        membershipType == other.membershipType &&
        termStart == other.termStart &&
        termEnd == other.termEnd &&
        voting == other.voting &&
        joinedAt == other.joinedAt;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, userKeycloakId.hashCode);
    _$hash = $jc(_$hash, membershipType.hashCode);
    _$hash = $jc(_$hash, termStart.hashCode);
    _$hash = $jc(_$hash, termEnd.hashCode);
    _$hash = $jc(_$hash, voting.hashCode);
    _$hash = $jc(_$hash, joinedAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'$OrgUnitMember')
          ..add('id', id)
          ..add('orgUnitId', orgUnitId)
          ..add('userKeycloakId', userKeycloakId)
          ..add('membershipType', membershipType)
          ..add('termStart', termStart)
          ..add('termEnd', termEnd)
          ..add('voting', voting)
          ..add('joinedAt', joinedAt))
        .toString();
  }
}

class $OrgUnitMemberBuilder
    implements
        Builder<$OrgUnitMember, $OrgUnitMemberBuilder>,
        OrgUnitMemberBuilder {
  _$$OrgUnitMember? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(covariant String? id) => _$this._id = id;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(covariant String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  String? _userKeycloakId;
  String? get userKeycloakId => _$this._userKeycloakId;
  set userKeycloakId(covariant String? userKeycloakId) =>
      _$this._userKeycloakId = userKeycloakId;

  OrgUnitMemberMembershipTypeEnum? _membershipType;
  OrgUnitMemberMembershipTypeEnum? get membershipType => _$this._membershipType;
  set membershipType(
          covariant OrgUnitMemberMembershipTypeEnum? membershipType) =>
      _$this._membershipType = membershipType;

  Date? _termStart;
  Date? get termStart => _$this._termStart;
  set termStart(covariant Date? termStart) => _$this._termStart = termStart;

  Date? _termEnd;
  Date? get termEnd => _$this._termEnd;
  set termEnd(covariant Date? termEnd) => _$this._termEnd = termEnd;

  bool? _voting;
  bool? get voting => _$this._voting;
  set voting(covariant bool? voting) => _$this._voting = voting;

  DateTime? _joinedAt;
  DateTime? get joinedAt => _$this._joinedAt;
  set joinedAt(covariant DateTime? joinedAt) => _$this._joinedAt = joinedAt;

  $OrgUnitMemberBuilder() {
    $OrgUnitMember._defaults(this);
  }

  $OrgUnitMemberBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _orgUnitId = $v.orgUnitId;
      _userKeycloakId = $v.userKeycloakId;
      _membershipType = $v.membershipType;
      _termStart = $v.termStart;
      _termEnd = $v.termEnd;
      _voting = $v.voting;
      _joinedAt = $v.joinedAt;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(covariant $OrgUnitMember other) {
    _$v = other as _$$OrgUnitMember;
  }

  @override
  void update(void Function($OrgUnitMemberBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  $OrgUnitMember build() => _build();

  _$$OrgUnitMember _build() {
    final _$result = _$v ??
        _$$OrgUnitMember._(
          id: BuiltValueNullFieldError.checkNotNull(
              id, r'$OrgUnitMember', 'id'),
          orgUnitId: BuiltValueNullFieldError.checkNotNull(
              orgUnitId, r'$OrgUnitMember', 'orgUnitId'),
          userKeycloakId: BuiltValueNullFieldError.checkNotNull(
              userKeycloakId, r'$OrgUnitMember', 'userKeycloakId'),
          membershipType: BuiltValueNullFieldError.checkNotNull(
              membershipType, r'$OrgUnitMember', 'membershipType'),
          termStart: termStart,
          termEnd: termEnd,
          voting: BuiltValueNullFieldError.checkNotNull(
              voting, r'$OrgUnitMember', 'voting'),
          joinedAt: BuiltValueNullFieldError.checkNotNull(
              joinedAt, r'$OrgUnitMember', 'joinedAt'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
