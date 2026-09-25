// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'role_assignment.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const RoleAssignmentStatusEnum _$roleAssignmentStatusEnum_active =
    const RoleAssignmentStatusEnum._('active');
const RoleAssignmentStatusEnum _$roleAssignmentStatusEnum_grace =
    const RoleAssignmentStatusEnum._('grace');
const RoleAssignmentStatusEnum _$roleAssignmentStatusEnum_expired =
    const RoleAssignmentStatusEnum._('expired');
const RoleAssignmentStatusEnum _$roleAssignmentStatusEnum_vacated =
    const RoleAssignmentStatusEnum._('vacated');
const RoleAssignmentStatusEnum
    _$roleAssignmentStatusEnum_unknownDefaultOpenApi =
    const RoleAssignmentStatusEnum._('unknownDefaultOpenApi');

RoleAssignmentStatusEnum _$roleAssignmentStatusEnumValueOf(String name) {
  switch (name) {
    case 'active':
      return _$roleAssignmentStatusEnum_active;
    case 'grace':
      return _$roleAssignmentStatusEnum_grace;
    case 'expired':
      return _$roleAssignmentStatusEnum_expired;
    case 'vacated':
      return _$roleAssignmentStatusEnum_vacated;
    case 'unknownDefaultOpenApi':
      return _$roleAssignmentStatusEnum_unknownDefaultOpenApi;
    default:
      return _$roleAssignmentStatusEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<RoleAssignmentStatusEnum> _$roleAssignmentStatusEnumValues =
    BuiltSet<RoleAssignmentStatusEnum>(const <RoleAssignmentStatusEnum>[
  _$roleAssignmentStatusEnum_active,
  _$roleAssignmentStatusEnum_grace,
  _$roleAssignmentStatusEnum_expired,
  _$roleAssignmentStatusEnum_vacated,
  _$roleAssignmentStatusEnum_unknownDefaultOpenApi,
]);

Serializer<RoleAssignmentStatusEnum> _$roleAssignmentStatusEnumSerializer =
    _$RoleAssignmentStatusEnumSerializer();

class _$RoleAssignmentStatusEnumSerializer
    implements PrimitiveSerializer<RoleAssignmentStatusEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'active': 'active',
    'grace': 'grace',
    'expired': 'expired',
    'vacated': 'vacated',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'active': 'active',
    'grace': 'grace',
    'expired': 'expired',
    'vacated': 'vacated',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[RoleAssignmentStatusEnum];
  @override
  final String wireName = 'RoleAssignmentStatusEnum';

  @override
  Object serialize(Serializers serializers, RoleAssignmentStatusEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  RoleAssignmentStatusEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      RoleAssignmentStatusEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$RoleAssignment extends RoleAssignment {
  @override
  final String id;
  @override
  final String roleId;
  @override
  final String userKeycloakId;
  @override
  final DateTime? startDate;
  @override
  final DateTime? endDate;
  @override
  final RoleAssignmentStatusEnum status;
  @override
  final String assignedByKeycloakId;
  @override
  final String? heliosElectionId;
  @override
  final DateTime createdAt;

  factory _$RoleAssignment([void Function(RoleAssignmentBuilder)? updates]) =>
      (RoleAssignmentBuilder()..update(updates))._build();

  _$RoleAssignment._(
      {required this.id,
      required this.roleId,
      required this.userKeycloakId,
      this.startDate,
      this.endDate,
      required this.status,
      required this.assignedByKeycloakId,
      this.heliosElectionId,
      required this.createdAt})
      : super._();
  @override
  RoleAssignment rebuild(void Function(RoleAssignmentBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  RoleAssignmentBuilder toBuilder() => RoleAssignmentBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is RoleAssignment &&
        id == other.id &&
        roleId == other.roleId &&
        userKeycloakId == other.userKeycloakId &&
        startDate == other.startDate &&
        endDate == other.endDate &&
        status == other.status &&
        assignedByKeycloakId == other.assignedByKeycloakId &&
        heliosElectionId == other.heliosElectionId &&
        createdAt == other.createdAt;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, roleId.hashCode);
    _$hash = $jc(_$hash, userKeycloakId.hashCode);
    _$hash = $jc(_$hash, startDate.hashCode);
    _$hash = $jc(_$hash, endDate.hashCode);
    _$hash = $jc(_$hash, status.hashCode);
    _$hash = $jc(_$hash, assignedByKeycloakId.hashCode);
    _$hash = $jc(_$hash, heliosElectionId.hashCode);
    _$hash = $jc(_$hash, createdAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'RoleAssignment')
          ..add('id', id)
          ..add('roleId', roleId)
          ..add('userKeycloakId', userKeycloakId)
          ..add('startDate', startDate)
          ..add('endDate', endDate)
          ..add('status', status)
          ..add('assignedByKeycloakId', assignedByKeycloakId)
          ..add('heliosElectionId', heliosElectionId)
          ..add('createdAt', createdAt))
        .toString();
  }
}

class RoleAssignmentBuilder
    implements Builder<RoleAssignment, RoleAssignmentBuilder> {
  _$RoleAssignment? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  String? _roleId;
  String? get roleId => _$this._roleId;
  set roleId(String? roleId) => _$this._roleId = roleId;

  String? _userKeycloakId;
  String? get userKeycloakId => _$this._userKeycloakId;
  set userKeycloakId(String? userKeycloakId) =>
      _$this._userKeycloakId = userKeycloakId;

  DateTime? _startDate;
  DateTime? get startDate => _$this._startDate;
  set startDate(DateTime? startDate) => _$this._startDate = startDate;

  DateTime? _endDate;
  DateTime? get endDate => _$this._endDate;
  set endDate(DateTime? endDate) => _$this._endDate = endDate;

  RoleAssignmentStatusEnum? _status;
  RoleAssignmentStatusEnum? get status => _$this._status;
  set status(RoleAssignmentStatusEnum? status) => _$this._status = status;

  String? _assignedByKeycloakId;
  String? get assignedByKeycloakId => _$this._assignedByKeycloakId;
  set assignedByKeycloakId(String? assignedByKeycloakId) =>
      _$this._assignedByKeycloakId = assignedByKeycloakId;

  String? _heliosElectionId;
  String? get heliosElectionId => _$this._heliosElectionId;
  set heliosElectionId(String? heliosElectionId) =>
      _$this._heliosElectionId = heliosElectionId;

  DateTime? _createdAt;
  DateTime? get createdAt => _$this._createdAt;
  set createdAt(DateTime? createdAt) => _$this._createdAt = createdAt;

  RoleAssignmentBuilder() {
    RoleAssignment._defaults(this);
  }

  RoleAssignmentBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _roleId = $v.roleId;
      _userKeycloakId = $v.userKeycloakId;
      _startDate = $v.startDate;
      _endDate = $v.endDate;
      _status = $v.status;
      _assignedByKeycloakId = $v.assignedByKeycloakId;
      _heliosElectionId = $v.heliosElectionId;
      _createdAt = $v.createdAt;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(RoleAssignment other) {
    _$v = other as _$RoleAssignment;
  }

  @override
  void update(void Function(RoleAssignmentBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  RoleAssignment build() => _build();

  _$RoleAssignment _build() {
    final _$result = _$v ??
        _$RoleAssignment._(
          id: BuiltValueNullFieldError.checkNotNull(
              id, r'RoleAssignment', 'id'),
          roleId: BuiltValueNullFieldError.checkNotNull(
              roleId, r'RoleAssignment', 'roleId'),
          userKeycloakId: BuiltValueNullFieldError.checkNotNull(
              userKeycloakId, r'RoleAssignment', 'userKeycloakId'),
          startDate: startDate,
          endDate: endDate,
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'RoleAssignment', 'status'),
          assignedByKeycloakId: BuiltValueNullFieldError.checkNotNull(
              assignedByKeycloakId, r'RoleAssignment', 'assignedByKeycloakId'),
          heliosElectionId: heliosElectionId,
          createdAt: BuiltValueNullFieldError.checkNotNull(
              createdAt, r'RoleAssignment', 'createdAt'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
