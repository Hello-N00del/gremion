// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'committee_role.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const CommitteeRoleElectionMethodEnum _$committeeRoleElectionMethodEnum_helios =
    const CommitteeRoleElectionMethodEnum._('helios');
const CommitteeRoleElectionMethodEnum _$committeeRoleElectionMethodEnum_poll =
    const CommitteeRoleElectionMethodEnum._('poll');
const CommitteeRoleElectionMethodEnum _$committeeRoleElectionMethodEnum_manual =
    const CommitteeRoleElectionMethodEnum._('manual');
const CommitteeRoleElectionMethodEnum
    _$committeeRoleElectionMethodEnum_unknownDefaultOpenApi =
    const CommitteeRoleElectionMethodEnum._('unknownDefaultOpenApi');

CommitteeRoleElectionMethodEnum _$committeeRoleElectionMethodEnumValueOf(
    String name) {
  switch (name) {
    case 'helios':
      return _$committeeRoleElectionMethodEnum_helios;
    case 'poll':
      return _$committeeRoleElectionMethodEnum_poll;
    case 'manual':
      return _$committeeRoleElectionMethodEnum_manual;
    case 'unknownDefaultOpenApi':
      return _$committeeRoleElectionMethodEnum_unknownDefaultOpenApi;
    default:
      return _$committeeRoleElectionMethodEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<CommitteeRoleElectionMethodEnum>
    _$committeeRoleElectionMethodEnumValues = BuiltSet<
        CommitteeRoleElectionMethodEnum>(const <CommitteeRoleElectionMethodEnum>[
  _$committeeRoleElectionMethodEnum_helios,
  _$committeeRoleElectionMethodEnum_poll,
  _$committeeRoleElectionMethodEnum_manual,
  _$committeeRoleElectionMethodEnum_unknownDefaultOpenApi,
]);

Serializer<CommitteeRoleElectionMethodEnum>
    _$committeeRoleElectionMethodEnumSerializer =
    _$CommitteeRoleElectionMethodEnumSerializer();

class _$CommitteeRoleElectionMethodEnumSerializer
    implements PrimitiveSerializer<CommitteeRoleElectionMethodEnum> {
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
  final Iterable<Type> types = const <Type>[CommitteeRoleElectionMethodEnum];
  @override
  final String wireName = 'CommitteeRoleElectionMethodEnum';

  @override
  Object serialize(
          Serializers serializers, CommitteeRoleElectionMethodEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  CommitteeRoleElectionMethodEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      CommitteeRoleElectionMethodEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$CommitteeRole extends CommitteeRole {
  @override
  final String id;
  @override
  final String orgUnitId;
  @override
  final String name;
  @override
  final CommitteeRoleElectionMethodEnum electionMethod;
  @override
  final bool isElected;
  @override
  final int gracePeriodDays;

  factory _$CommitteeRole([void Function(CommitteeRoleBuilder)? updates]) =>
      (CommitteeRoleBuilder()..update(updates))._build();

  _$CommitteeRole._(
      {required this.id,
      required this.orgUnitId,
      required this.name,
      required this.electionMethod,
      required this.isElected,
      required this.gracePeriodDays})
      : super._();
  @override
  CommitteeRole rebuild(void Function(CommitteeRoleBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  CommitteeRoleBuilder toBuilder() => CommitteeRoleBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is CommitteeRole &&
        id == other.id &&
        orgUnitId == other.orgUnitId &&
        name == other.name &&
        electionMethod == other.electionMethod &&
        isElected == other.isElected &&
        gracePeriodDays == other.gracePeriodDays;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, electionMethod.hashCode);
    _$hash = $jc(_$hash, isElected.hashCode);
    _$hash = $jc(_$hash, gracePeriodDays.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'CommitteeRole')
          ..add('id', id)
          ..add('orgUnitId', orgUnitId)
          ..add('name', name)
          ..add('electionMethod', electionMethod)
          ..add('isElected', isElected)
          ..add('gracePeriodDays', gracePeriodDays))
        .toString();
  }
}

class CommitteeRoleBuilder
    implements Builder<CommitteeRole, CommitteeRoleBuilder> {
  _$CommitteeRole? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  CommitteeRoleElectionMethodEnum? _electionMethod;
  CommitteeRoleElectionMethodEnum? get electionMethod => _$this._electionMethod;
  set electionMethod(CommitteeRoleElectionMethodEnum? electionMethod) =>
      _$this._electionMethod = electionMethod;

  bool? _isElected;
  bool? get isElected => _$this._isElected;
  set isElected(bool? isElected) => _$this._isElected = isElected;

  int? _gracePeriodDays;
  int? get gracePeriodDays => _$this._gracePeriodDays;
  set gracePeriodDays(int? gracePeriodDays) =>
      _$this._gracePeriodDays = gracePeriodDays;

  CommitteeRoleBuilder() {
    CommitteeRole._defaults(this);
  }

  CommitteeRoleBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _orgUnitId = $v.orgUnitId;
      _name = $v.name;
      _electionMethod = $v.electionMethod;
      _isElected = $v.isElected;
      _gracePeriodDays = $v.gracePeriodDays;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(CommitteeRole other) {
    _$v = other as _$CommitteeRole;
  }

  @override
  void update(void Function(CommitteeRoleBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  CommitteeRole build() => _build();

  _$CommitteeRole _build() {
    final _$result = _$v ??
        _$CommitteeRole._(
          id: BuiltValueNullFieldError.checkNotNull(id, r'CommitteeRole', 'id'),
          orgUnitId: BuiltValueNullFieldError.checkNotNull(
              orgUnitId, r'CommitteeRole', 'orgUnitId'),
          name: BuiltValueNullFieldError.checkNotNull(
              name, r'CommitteeRole', 'name'),
          electionMethod: BuiltValueNullFieldError.checkNotNull(
              electionMethod, r'CommitteeRole', 'electionMethod'),
          isElected: BuiltValueNullFieldError.checkNotNull(
              isElected, r'CommitteeRole', 'isElected'),
          gracePeriodDays: BuiltValueNullFieldError.checkNotNull(
              gracePeriodDays, r'CommitteeRole', 'gracePeriodDays'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
