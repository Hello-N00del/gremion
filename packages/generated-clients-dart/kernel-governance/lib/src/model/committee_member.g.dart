// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'committee_member.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const CommitteeMemberMembershipTypeEnum
    _$committeeMemberMembershipTypeEnum_elected =
    const CommitteeMemberMembershipTypeEnum._('elected');
const CommitteeMemberMembershipTypeEnum
    _$committeeMemberMembershipTypeEnum_unelected =
    const CommitteeMemberMembershipTypeEnum._('unelected');
const CommitteeMemberMembershipTypeEnum
    _$committeeMemberMembershipTypeEnum_employee =
    const CommitteeMemberMembershipTypeEnum._('employee');

CommitteeMemberMembershipTypeEnum _$committeeMemberMembershipTypeEnumValueOf(
    String name) {
  switch (name) {
    case 'elected':
      return _$committeeMemberMembershipTypeEnum_elected;
    case 'unelected':
      return _$committeeMemberMembershipTypeEnum_unelected;
    case 'employee':
      return _$committeeMemberMembershipTypeEnum_employee;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<CommitteeMemberMembershipTypeEnum>
    _$committeeMemberMembershipTypeEnumValues = BuiltSet<
        CommitteeMemberMembershipTypeEnum>(const <CommitteeMemberMembershipTypeEnum>[
  _$committeeMemberMembershipTypeEnum_elected,
  _$committeeMemberMembershipTypeEnum_unelected,
  _$committeeMemberMembershipTypeEnum_employee,
]);

Serializer<CommitteeMemberMembershipTypeEnum>
    _$committeeMemberMembershipTypeEnumSerializer =
    _$CommitteeMemberMembershipTypeEnumSerializer();

class _$CommitteeMemberMembershipTypeEnumSerializer
    implements PrimitiveSerializer<CommitteeMemberMembershipTypeEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'elected': 'elected',
    'unelected': 'unelected',
    'employee': 'employee',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'elected': 'elected',
    'unelected': 'unelected',
    'employee': 'employee',
  };

  @override
  final Iterable<Type> types = const <Type>[CommitteeMemberMembershipTypeEnum];
  @override
  final String wireName = 'CommitteeMemberMembershipTypeEnum';

  @override
  Object serialize(
          Serializers serializers, CommitteeMemberMembershipTypeEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  CommitteeMemberMembershipTypeEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      CommitteeMemberMembershipTypeEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$CommitteeMember extends CommitteeMember {
  @override
  final String? name;
  @override
  final String? email;
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

  factory _$CommitteeMember([void Function(CommitteeMemberBuilder)? updates]) =>
      (CommitteeMemberBuilder()..update(updates))._build();

  _$CommitteeMember._(
      {this.name,
      this.email,
      required this.id,
      required this.orgUnitId,
      required this.userKeycloakId,
      required this.membershipType,
      this.termStart,
      this.termEnd,
      required this.voting,
      required this.joinedAt})
      : super._();
  @override
  CommitteeMember rebuild(void Function(CommitteeMemberBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  CommitteeMemberBuilder toBuilder() => CommitteeMemberBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is CommitteeMember &&
        name == other.name &&
        email == other.email &&
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
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, email.hashCode);
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
    return (newBuiltValueToStringHelper(r'CommitteeMember')
          ..add('name', name)
          ..add('email', email)
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

class CommitteeMemberBuilder
    implements
        Builder<CommitteeMember, CommitteeMemberBuilder>,
        OrgUnitMemberBuilder {
  _$CommitteeMember? _$v;

  String? _name;
  String? get name => _$this._name;
  set name(covariant String? name) => _$this._name = name;

  String? _email;
  String? get email => _$this._email;
  set email(covariant String? email) => _$this._email = email;

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

  CommitteeMemberBuilder() {
    CommitteeMember._defaults(this);
  }

  CommitteeMemberBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _name = $v.name;
      _email = $v.email;
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
  void replace(covariant CommitteeMember other) {
    _$v = other as _$CommitteeMember;
  }

  @override
  void update(void Function(CommitteeMemberBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  CommitteeMember build() => _build();

  _$CommitteeMember _build() {
    final _$result = _$v ??
        _$CommitteeMember._(
          name: name,
          email: email,
          id: BuiltValueNullFieldError.checkNotNull(
              id, r'CommitteeMember', 'id'),
          orgUnitId: BuiltValueNullFieldError.checkNotNull(
              orgUnitId, r'CommitteeMember', 'orgUnitId'),
          userKeycloakId: BuiltValueNullFieldError.checkNotNull(
              userKeycloakId, r'CommitteeMember', 'userKeycloakId'),
          membershipType: BuiltValueNullFieldError.checkNotNull(
              membershipType, r'CommitteeMember', 'membershipType'),
          termStart: termStart,
          termEnd: termEnd,
          voting: BuiltValueNullFieldError.checkNotNull(
              voting, r'CommitteeMember', 'voting'),
          joinedAt: BuiltValueNullFieldError.checkNotNull(
              joinedAt, r'CommitteeMember', 'joinedAt'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
