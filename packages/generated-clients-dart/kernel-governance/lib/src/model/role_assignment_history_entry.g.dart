// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'role_assignment_history_entry.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const RoleAssignmentHistoryEntryEndedReasonEnum
    _$roleAssignmentHistoryEntryEndedReasonEnum_expired =
    const RoleAssignmentHistoryEntryEndedReasonEnum._('expired');
const RoleAssignmentHistoryEntryEndedReasonEnum
    _$roleAssignmentHistoryEntryEndedReasonEnum_resigned =
    const RoleAssignmentHistoryEntryEndedReasonEnum._('resigned');
const RoleAssignmentHistoryEntryEndedReasonEnum
    _$roleAssignmentHistoryEntryEndedReasonEnum_removed =
    const RoleAssignmentHistoryEntryEndedReasonEnum._('removed');

RoleAssignmentHistoryEntryEndedReasonEnum
    _$roleAssignmentHistoryEntryEndedReasonEnumValueOf(String name) {
  switch (name) {
    case 'expired':
      return _$roleAssignmentHistoryEntryEndedReasonEnum_expired;
    case 'resigned':
      return _$roleAssignmentHistoryEntryEndedReasonEnum_resigned;
    case 'removed':
      return _$roleAssignmentHistoryEntryEndedReasonEnum_removed;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<RoleAssignmentHistoryEntryEndedReasonEnum>
    _$roleAssignmentHistoryEntryEndedReasonEnumValues = BuiltSet<
        RoleAssignmentHistoryEntryEndedReasonEnum>(const <RoleAssignmentHistoryEntryEndedReasonEnum>[
  _$roleAssignmentHistoryEntryEndedReasonEnum_expired,
  _$roleAssignmentHistoryEntryEndedReasonEnum_resigned,
  _$roleAssignmentHistoryEntryEndedReasonEnum_removed,
]);

Serializer<RoleAssignmentHistoryEntryEndedReasonEnum>
    _$roleAssignmentHistoryEntryEndedReasonEnumSerializer =
    _$RoleAssignmentHistoryEntryEndedReasonEnumSerializer();

class _$RoleAssignmentHistoryEntryEndedReasonEnumSerializer
    implements PrimitiveSerializer<RoleAssignmentHistoryEntryEndedReasonEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'expired': 'expired',
    'resigned': 'resigned',
    'removed': 'removed',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'expired': 'expired',
    'resigned': 'resigned',
    'removed': 'removed',
  };

  @override
  final Iterable<Type> types = const <Type>[
    RoleAssignmentHistoryEntryEndedReasonEnum
  ];
  @override
  final String wireName = 'RoleAssignmentHistoryEntryEndedReasonEnum';

  @override
  Object serialize(Serializers serializers,
          RoleAssignmentHistoryEntryEndedReasonEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  RoleAssignmentHistoryEntryEndedReasonEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      RoleAssignmentHistoryEntryEndedReasonEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$RoleAssignmentHistoryEntry extends RoleAssignmentHistoryEntry {
  @override
  final String id;
  @override
  final String roleId;
  @override
  final String? userKeycloakId;
  @override
  final DateTime startDate;
  @override
  final DateTime endDate;
  @override
  final RoleAssignmentHistoryEntryEndedReasonEnum endedReason;
  @override
  final DateTime createdAt;

  factory _$RoleAssignmentHistoryEntry(
          [void Function(RoleAssignmentHistoryEntryBuilder)? updates]) =>
      (RoleAssignmentHistoryEntryBuilder()..update(updates))._build();

  _$RoleAssignmentHistoryEntry._(
      {required this.id,
      required this.roleId,
      this.userKeycloakId,
      required this.startDate,
      required this.endDate,
      required this.endedReason,
      required this.createdAt})
      : super._();
  @override
  RoleAssignmentHistoryEntry rebuild(
          void Function(RoleAssignmentHistoryEntryBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  RoleAssignmentHistoryEntryBuilder toBuilder() =>
      RoleAssignmentHistoryEntryBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is RoleAssignmentHistoryEntry &&
        id == other.id &&
        roleId == other.roleId &&
        userKeycloakId == other.userKeycloakId &&
        startDate == other.startDate &&
        endDate == other.endDate &&
        endedReason == other.endedReason &&
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
    _$hash = $jc(_$hash, endedReason.hashCode);
    _$hash = $jc(_$hash, createdAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'RoleAssignmentHistoryEntry')
          ..add('id', id)
          ..add('roleId', roleId)
          ..add('userKeycloakId', userKeycloakId)
          ..add('startDate', startDate)
          ..add('endDate', endDate)
          ..add('endedReason', endedReason)
          ..add('createdAt', createdAt))
        .toString();
  }
}

class RoleAssignmentHistoryEntryBuilder
    implements
        Builder<RoleAssignmentHistoryEntry, RoleAssignmentHistoryEntryBuilder> {
  _$RoleAssignmentHistoryEntry? _$v;

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

  RoleAssignmentHistoryEntryEndedReasonEnum? _endedReason;
  RoleAssignmentHistoryEntryEndedReasonEnum? get endedReason =>
      _$this._endedReason;
  set endedReason(RoleAssignmentHistoryEntryEndedReasonEnum? endedReason) =>
      _$this._endedReason = endedReason;

  DateTime? _createdAt;
  DateTime? get createdAt => _$this._createdAt;
  set createdAt(DateTime? createdAt) => _$this._createdAt = createdAt;

  RoleAssignmentHistoryEntryBuilder() {
    RoleAssignmentHistoryEntry._defaults(this);
  }

  RoleAssignmentHistoryEntryBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _roleId = $v.roleId;
      _userKeycloakId = $v.userKeycloakId;
      _startDate = $v.startDate;
      _endDate = $v.endDate;
      _endedReason = $v.endedReason;
      _createdAt = $v.createdAt;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(RoleAssignmentHistoryEntry other) {
    _$v = other as _$RoleAssignmentHistoryEntry;
  }

  @override
  void update(void Function(RoleAssignmentHistoryEntryBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  RoleAssignmentHistoryEntry build() => _build();

  _$RoleAssignmentHistoryEntry _build() {
    final _$result = _$v ??
        _$RoleAssignmentHistoryEntry._(
          id: BuiltValueNullFieldError.checkNotNull(
              id, r'RoleAssignmentHistoryEntry', 'id'),
          roleId: BuiltValueNullFieldError.checkNotNull(
              roleId, r'RoleAssignmentHistoryEntry', 'roleId'),
          userKeycloakId: userKeycloakId,
          startDate: BuiltValueNullFieldError.checkNotNull(
              startDate, r'RoleAssignmentHistoryEntry', 'startDate'),
          endDate: BuiltValueNullFieldError.checkNotNull(
              endDate, r'RoleAssignmentHistoryEntry', 'endDate'),
          endedReason: BuiltValueNullFieldError.checkNotNull(
              endedReason, r'RoleAssignmentHistoryEntry', 'endedReason'),
          createdAt: BuiltValueNullFieldError.checkNotNull(
              createdAt, r'RoleAssignmentHistoryEntry', 'createdAt'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
