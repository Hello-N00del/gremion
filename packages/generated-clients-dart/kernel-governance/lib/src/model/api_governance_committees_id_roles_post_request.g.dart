// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_roles_post_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum
    _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_helios =
    const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum._(
        'helios');
const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum
    _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_poll =
    const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum._('poll');
const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum
    _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_manual =
    const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum._(
        'manual');
const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum
    _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_unknownDefaultOpenApi =
    const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum._(
        'unknownDefaultOpenApi');

ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum
    _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumValueOf(
        String name) {
  switch (name) {
    case 'helios':
      return _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_helios;
    case 'poll':
      return _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_poll;
    case 'manual':
      return _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_manual;
    case 'unknownDefaultOpenApi':
      return _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_unknownDefaultOpenApi;
    default:
      return _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum>
    _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumValues =
    BuiltSet<
        ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum>(const <ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum>[
  _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_helios,
  _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_poll,
  _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_manual,
  _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_unknownDefaultOpenApi,
]);

Serializer<ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum>
    _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumSerializer =
    _$ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumSerializer();

class _$ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumSerializer
    implements
        PrimitiveSerializer<
            ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'helios': 'helios',
    'poll': 'poll',
    'manual': 'manual',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'helios': 'helios',
    'poll': 'poll',
    'manual': 'manual',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[
    ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum
  ];
  @override
  final String wireName =
      'ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum';

  @override
  Object serialize(Serializers serializers,
          ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$ApiGovernanceCommitteesIdRolesPostRequest
    extends ApiGovernanceCommitteesIdRolesPostRequest {
  @override
  final String name;
  @override
  final ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum?
      electionMethod;
  @override
  final bool? isElected;
  @override
  final int? gracePeriodDays;

  factory _$ApiGovernanceCommitteesIdRolesPostRequest(
          [void Function(ApiGovernanceCommitteesIdRolesPostRequestBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdRolesPostRequestBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdRolesPostRequest._(
      {required this.name,
      this.electionMethod,
      this.isElected,
      this.gracePeriodDays})
      : super._();
  @override
  ApiGovernanceCommitteesIdRolesPostRequest rebuild(
          void Function(ApiGovernanceCommitteesIdRolesPostRequestBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdRolesPostRequestBuilder toBuilder() =>
      ApiGovernanceCommitteesIdRolesPostRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdRolesPostRequest &&
        name == other.name &&
        electionMethod == other.electionMethod &&
        isElected == other.isElected &&
        gracePeriodDays == other.gracePeriodDays;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, electionMethod.hashCode);
    _$hash = $jc(_$hash, isElected.hashCode);
    _$hash = $jc(_$hash, gracePeriodDays.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdRolesPostRequest')
          ..add('name', name)
          ..add('electionMethod', electionMethod)
          ..add('isElected', isElected)
          ..add('gracePeriodDays', gracePeriodDays))
        .toString();
  }
}

class ApiGovernanceCommitteesIdRolesPostRequestBuilder
    implements
        Builder<ApiGovernanceCommitteesIdRolesPostRequest,
            ApiGovernanceCommitteesIdRolesPostRequestBuilder> {
  _$ApiGovernanceCommitteesIdRolesPostRequest? _$v;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum? _electionMethod;
  ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum?
      get electionMethod => _$this._electionMethod;
  set electionMethod(
          ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum?
              electionMethod) =>
      _$this._electionMethod = electionMethod;

  bool? _isElected;
  bool? get isElected => _$this._isElected;
  set isElected(bool? isElected) => _$this._isElected = isElected;

  int? _gracePeriodDays;
  int? get gracePeriodDays => _$this._gracePeriodDays;
  set gracePeriodDays(int? gracePeriodDays) =>
      _$this._gracePeriodDays = gracePeriodDays;

  ApiGovernanceCommitteesIdRolesPostRequestBuilder() {
    ApiGovernanceCommitteesIdRolesPostRequest._defaults(this);
  }

  ApiGovernanceCommitteesIdRolesPostRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _name = $v.name;
      _electionMethod = $v.electionMethod;
      _isElected = $v.isElected;
      _gracePeriodDays = $v.gracePeriodDays;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdRolesPostRequest other) {
    _$v = other as _$ApiGovernanceCommitteesIdRolesPostRequest;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdRolesPostRequestBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdRolesPostRequest build() => _build();

  _$ApiGovernanceCommitteesIdRolesPostRequest _build() {
    final _$result = _$v ??
        _$ApiGovernanceCommitteesIdRolesPostRequest._(
          name: BuiltValueNullFieldError.checkNotNull(
              name, r'ApiGovernanceCommitteesIdRolesPostRequest', 'name'),
          electionMethod: electionMethod,
          isElected: isElected,
          gracePeriodDays: gracePeriodDays,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
