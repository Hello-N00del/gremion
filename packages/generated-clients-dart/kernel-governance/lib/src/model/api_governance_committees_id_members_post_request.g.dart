// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_members_post_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum
    _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_elected =
    const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum._(
        'elected');
const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum
    _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_unelected =
    const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum._(
        'unelected');
const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum
    _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_employee =
    const ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum._(
        'employee');

ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum
    _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumValueOf(
        String name) {
  switch (name) {
    case 'elected':
      return _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_elected;
    case 'unelected':
      return _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_unelected;
    case 'employee':
      return _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_employee;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum>
    _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumValues =
    BuiltSet<
        ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum>(const <ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum>[
  _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_elected,
  _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_unelected,
  _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum_employee,
]);

Serializer<ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum>
    _$apiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumSerializer =
    _$ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumSerializer();

class _$ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnumSerializer
    implements
        PrimitiveSerializer<
            ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum> {
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
  final Iterable<Type> types = const <Type>[
    ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum
  ];
  @override
  final String wireName =
      'ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum';

  @override
  Object serialize(Serializers serializers,
          ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$ApiGovernanceCommitteesIdMembersPostRequest
    extends ApiGovernanceCommitteesIdMembersPostRequest {
  @override
  final String userKeycloakId;
  @override
  final ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum?
      membershipType;
  @override
  final Date? termStart;
  @override
  final Date? termEnd;

  factory _$ApiGovernanceCommitteesIdMembersPostRequest(
          [void Function(ApiGovernanceCommitteesIdMembersPostRequestBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdMembersPostRequestBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdMembersPostRequest._(
      {required this.userKeycloakId,
      this.membershipType,
      this.termStart,
      this.termEnd})
      : super._();
  @override
  ApiGovernanceCommitteesIdMembersPostRequest rebuild(
          void Function(ApiGovernanceCommitteesIdMembersPostRequestBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdMembersPostRequestBuilder toBuilder() =>
      ApiGovernanceCommitteesIdMembersPostRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdMembersPostRequest &&
        userKeycloakId == other.userKeycloakId &&
        membershipType == other.membershipType &&
        termStart == other.termStart &&
        termEnd == other.termEnd;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, userKeycloakId.hashCode);
    _$hash = $jc(_$hash, membershipType.hashCode);
    _$hash = $jc(_$hash, termStart.hashCode);
    _$hash = $jc(_$hash, termEnd.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdMembersPostRequest')
          ..add('userKeycloakId', userKeycloakId)
          ..add('membershipType', membershipType)
          ..add('termStart', termStart)
          ..add('termEnd', termEnd))
        .toString();
  }
}

class ApiGovernanceCommitteesIdMembersPostRequestBuilder
    implements
        Builder<ApiGovernanceCommitteesIdMembersPostRequest,
            ApiGovernanceCommitteesIdMembersPostRequestBuilder> {
  _$ApiGovernanceCommitteesIdMembersPostRequest? _$v;

  String? _userKeycloakId;
  String? get userKeycloakId => _$this._userKeycloakId;
  set userKeycloakId(String? userKeycloakId) =>
      _$this._userKeycloakId = userKeycloakId;

  ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum?
      _membershipType;
  ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum?
      get membershipType => _$this._membershipType;
  set membershipType(
          ApiGovernanceCommitteesIdMembersPostRequestMembershipTypeEnum?
              membershipType) =>
      _$this._membershipType = membershipType;

  Date? _termStart;
  Date? get termStart => _$this._termStart;
  set termStart(Date? termStart) => _$this._termStart = termStart;

  Date? _termEnd;
  Date? get termEnd => _$this._termEnd;
  set termEnd(Date? termEnd) => _$this._termEnd = termEnd;

  ApiGovernanceCommitteesIdMembersPostRequestBuilder() {
    ApiGovernanceCommitteesIdMembersPostRequest._defaults(this);
  }

  ApiGovernanceCommitteesIdMembersPostRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _userKeycloakId = $v.userKeycloakId;
      _membershipType = $v.membershipType;
      _termStart = $v.termStart;
      _termEnd = $v.termEnd;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdMembersPostRequest other) {
    _$v = other as _$ApiGovernanceCommitteesIdMembersPostRequest;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdMembersPostRequestBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdMembersPostRequest build() => _build();

  _$ApiGovernanceCommitteesIdMembersPostRequest _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesIdMembersPostRequest._(
          userKeycloakId: BuiltValueNullFieldError.checkNotNull(userKeycloakId,
              r'ApiGovernanceCommitteesIdMembersPostRequest', 'userKeycloakId'),
          membershipType: membershipType,
          termStart: termStart,
          termEnd: termEnd,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
