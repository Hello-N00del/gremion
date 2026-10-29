// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'grant.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const GrantGrantKindEnum _$grantGrantKindEnum_role =
    const GrantGrantKindEnum._('role');
const GrantGrantKindEnum _$grantGrantKindEnum_capability =
    const GrantGrantKindEnum._('capability');
const GrantGrantKindEnum _$grantGrantKindEnum_unknownDefaultOpenApi =
    const GrantGrantKindEnum._('unknownDefaultOpenApi');

GrantGrantKindEnum _$grantGrantKindEnumValueOf(String name) {
  switch (name) {
    case 'role':
      return _$grantGrantKindEnum_role;
    case 'capability':
      return _$grantGrantKindEnum_capability;
    case 'unknownDefaultOpenApi':
      return _$grantGrantKindEnum_unknownDefaultOpenApi;
    default:
      return _$grantGrantKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<GrantGrantKindEnum> _$grantGrantKindEnumValues =
    BuiltSet<GrantGrantKindEnum>(const <GrantGrantKindEnum>[
  _$grantGrantKindEnum_role,
  _$grantGrantKindEnum_capability,
  _$grantGrantKindEnum_unknownDefaultOpenApi,
]);

const GrantGranterKindEnum _$grantGranterKindEnum_person =
    const GrantGranterKindEnum._('person');
const GrantGranterKindEnum _$grantGranterKindEnum_operator_ =
    const GrantGranterKindEnum._('operator_');
const GrantGranterKindEnum _$grantGranterKindEnum_system =
    const GrantGranterKindEnum._('system');
const GrantGranterKindEnum _$grantGranterKindEnum_unknownDefaultOpenApi =
    const GrantGranterKindEnum._('unknownDefaultOpenApi');

GrantGranterKindEnum _$grantGranterKindEnumValueOf(String name) {
  switch (name) {
    case 'person':
      return _$grantGranterKindEnum_person;
    case 'operator_':
      return _$grantGranterKindEnum_operator_;
    case 'system':
      return _$grantGranterKindEnum_system;
    case 'unknownDefaultOpenApi':
      return _$grantGranterKindEnum_unknownDefaultOpenApi;
    default:
      return _$grantGranterKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<GrantGranterKindEnum> _$grantGranterKindEnumValues =
    BuiltSet<GrantGranterKindEnum>(const <GrantGranterKindEnum>[
  _$grantGranterKindEnum_person,
  _$grantGranterKindEnum_operator_,
  _$grantGranterKindEnum_system,
  _$grantGranterKindEnum_unknownDefaultOpenApi,
]);

const GrantStateEnum _$grantStateEnum_scheduled =
    const GrantStateEnum._('scheduled');
const GrantStateEnum _$grantStateEnum_active = const GrantStateEnum._('active');
const GrantStateEnum _$grantStateEnum_expired =
    const GrantStateEnum._('expired');
const GrantStateEnum _$grantStateEnum_revoked =
    const GrantStateEnum._('revoked');
const GrantStateEnum _$grantStateEnum_unknownDefaultOpenApi =
    const GrantStateEnum._('unknownDefaultOpenApi');

GrantStateEnum _$grantStateEnumValueOf(String name) {
  switch (name) {
    case 'scheduled':
      return _$grantStateEnum_scheduled;
    case 'active':
      return _$grantStateEnum_active;
    case 'expired':
      return _$grantStateEnum_expired;
    case 'revoked':
      return _$grantStateEnum_revoked;
    case 'unknownDefaultOpenApi':
      return _$grantStateEnum_unknownDefaultOpenApi;
    default:
      return _$grantStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<GrantStateEnum> _$grantStateEnumValues =
    BuiltSet<GrantStateEnum>(const <GrantStateEnum>[
  _$grantStateEnum_scheduled,
  _$grantStateEnum_active,
  _$grantStateEnum_expired,
  _$grantStateEnum_revoked,
  _$grantStateEnum_unknownDefaultOpenApi,
]);

Serializer<GrantGrantKindEnum> _$grantGrantKindEnumSerializer =
    _$GrantGrantKindEnumSerializer();
Serializer<GrantGranterKindEnum> _$grantGranterKindEnumSerializer =
    _$GrantGranterKindEnumSerializer();
Serializer<GrantStateEnum> _$grantStateEnumSerializer =
    _$GrantStateEnumSerializer();

class _$GrantGrantKindEnumSerializer
    implements PrimitiveSerializer<GrantGrantKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'role': 'role',
    'capability': 'capability',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'role': 'role',
    'capability': 'capability',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[GrantGrantKindEnum];
  @override
  final String wireName = 'GrantGrantKindEnum';

  @override
  Object serialize(Serializers serializers, GrantGrantKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  GrantGrantKindEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      GrantGrantKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$GrantGranterKindEnumSerializer
    implements PrimitiveSerializer<GrantGranterKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'person': 'person',
    'operator_': 'operator',
    'system': 'system',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'person': 'person',
    'operator': 'operator_',
    'system': 'system',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[GrantGranterKindEnum];
  @override
  final String wireName = 'GrantGranterKindEnum';

  @override
  Object serialize(Serializers serializers, GrantGranterKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  GrantGranterKindEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      GrantGranterKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$GrantStateEnumSerializer
    implements PrimitiveSerializer<GrantStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'scheduled': 'scheduled',
    'active': 'active',
    'expired': 'expired',
    'revoked': 'revoked',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'scheduled': 'scheduled',
    'active': 'active',
    'expired': 'expired',
    'revoked': 'revoked',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[GrantStateEnum];
  @override
  final String wireName = 'GrantStateEnum';

  @override
  Object serialize(Serializers serializers, GrantStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  GrantStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      GrantStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Grant extends Grant {
  @override
  final String grantId;
  @override
  final String bodyId;
  @override
  final String subjectPersonId;
  @override
  final GrantGrantKindEnum grantKind;
  @override
  final String key;
  @override
  final String? resourceKind;
  @override
  final String? resourceId;
  @override
  final String validFrom;
  @override
  final String? validUntil;
  @override
  final GrantGranterKindEnum granterKind;
  @override
  final String source_;
  @override
  final GrantStateEnum state;
  @override
  final String? revokedAt;
  @override
  final String? revokeReason;
  @override
  final int rowVersion;

  factory _$Grant([void Function(GrantBuilder)? updates]) =>
      (GrantBuilder()..update(updates))._build();

  _$Grant._(
      {required this.grantId,
      required this.bodyId,
      required this.subjectPersonId,
      required this.grantKind,
      required this.key,
      this.resourceKind,
      this.resourceId,
      required this.validFrom,
      this.validUntil,
      required this.granterKind,
      required this.source_,
      required this.state,
      this.revokedAt,
      this.revokeReason,
      required this.rowVersion})
      : super._();
  @override
  Grant rebuild(void Function(GrantBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  GrantBuilder toBuilder() => GrantBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Grant &&
        grantId == other.grantId &&
        bodyId == other.bodyId &&
        subjectPersonId == other.subjectPersonId &&
        grantKind == other.grantKind &&
        key == other.key &&
        resourceKind == other.resourceKind &&
        resourceId == other.resourceId &&
        validFrom == other.validFrom &&
        validUntil == other.validUntil &&
        granterKind == other.granterKind &&
        source_ == other.source_ &&
        state == other.state &&
        revokedAt == other.revokedAt &&
        revokeReason == other.revokeReason &&
        rowVersion == other.rowVersion;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, grantId.hashCode);
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, subjectPersonId.hashCode);
    _$hash = $jc(_$hash, grantKind.hashCode);
    _$hash = $jc(_$hash, key.hashCode);
    _$hash = $jc(_$hash, resourceKind.hashCode);
    _$hash = $jc(_$hash, resourceId.hashCode);
    _$hash = $jc(_$hash, validFrom.hashCode);
    _$hash = $jc(_$hash, validUntil.hashCode);
    _$hash = $jc(_$hash, granterKind.hashCode);
    _$hash = $jc(_$hash, source_.hashCode);
    _$hash = $jc(_$hash, state.hashCode);
    _$hash = $jc(_$hash, revokedAt.hashCode);
    _$hash = $jc(_$hash, revokeReason.hashCode);
    _$hash = $jc(_$hash, rowVersion.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Grant')
          ..add('grantId', grantId)
          ..add('bodyId', bodyId)
          ..add('subjectPersonId', subjectPersonId)
          ..add('grantKind', grantKind)
          ..add('key', key)
          ..add('resourceKind', resourceKind)
          ..add('resourceId', resourceId)
          ..add('validFrom', validFrom)
          ..add('validUntil', validUntil)
          ..add('granterKind', granterKind)
          ..add('source_', source_)
          ..add('state', state)
          ..add('revokedAt', revokedAt)
          ..add('revokeReason', revokeReason)
          ..add('rowVersion', rowVersion))
        .toString();
  }
}

class GrantBuilder implements Builder<Grant, GrantBuilder> {
  _$Grant? _$v;

  String? _grantId;
  String? get grantId => _$this._grantId;
  set grantId(String? grantId) => _$this._grantId = grantId;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  String? _subjectPersonId;
  String? get subjectPersonId => _$this._subjectPersonId;
  set subjectPersonId(String? subjectPersonId) =>
      _$this._subjectPersonId = subjectPersonId;

  GrantGrantKindEnum? _grantKind;
  GrantGrantKindEnum? get grantKind => _$this._grantKind;
  set grantKind(GrantGrantKindEnum? grantKind) => _$this._grantKind = grantKind;

  String? _key;
  String? get key => _$this._key;
  set key(String? key) => _$this._key = key;

  String? _resourceKind;
  String? get resourceKind => _$this._resourceKind;
  set resourceKind(String? resourceKind) => _$this._resourceKind = resourceKind;

  String? _resourceId;
  String? get resourceId => _$this._resourceId;
  set resourceId(String? resourceId) => _$this._resourceId = resourceId;

  String? _validFrom;
  String? get validFrom => _$this._validFrom;
  set validFrom(String? validFrom) => _$this._validFrom = validFrom;

  String? _validUntil;
  String? get validUntil => _$this._validUntil;
  set validUntil(String? validUntil) => _$this._validUntil = validUntil;

  GrantGranterKindEnum? _granterKind;
  GrantGranterKindEnum? get granterKind => _$this._granterKind;
  set granterKind(GrantGranterKindEnum? granterKind) =>
      _$this._granterKind = granterKind;

  String? _source_;
  String? get source_ => _$this._source_;
  set source_(String? source_) => _$this._source_ = source_;

  GrantStateEnum? _state;
  GrantStateEnum? get state => _$this._state;
  set state(GrantStateEnum? state) => _$this._state = state;

  String? _revokedAt;
  String? get revokedAt => _$this._revokedAt;
  set revokedAt(String? revokedAt) => _$this._revokedAt = revokedAt;

  String? _revokeReason;
  String? get revokeReason => _$this._revokeReason;
  set revokeReason(String? revokeReason) => _$this._revokeReason = revokeReason;

  int? _rowVersion;
  int? get rowVersion => _$this._rowVersion;
  set rowVersion(int? rowVersion) => _$this._rowVersion = rowVersion;

  GrantBuilder() {
    Grant._defaults(this);
  }

  GrantBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _grantId = $v.grantId;
      _bodyId = $v.bodyId;
      _subjectPersonId = $v.subjectPersonId;
      _grantKind = $v.grantKind;
      _key = $v.key;
      _resourceKind = $v.resourceKind;
      _resourceId = $v.resourceId;
      _validFrom = $v.validFrom;
      _validUntil = $v.validUntil;
      _granterKind = $v.granterKind;
      _source_ = $v.source_;
      _state = $v.state;
      _revokedAt = $v.revokedAt;
      _revokeReason = $v.revokeReason;
      _rowVersion = $v.rowVersion;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Grant other) {
    _$v = other as _$Grant;
  }

  @override
  void update(void Function(GrantBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Grant build() => _build();

  _$Grant _build() {
    final _$result = _$v ??
        _$Grant._(
          grantId: BuiltValueNullFieldError.checkNotNull(
              grantId, r'Grant', 'grantId'),
          bodyId:
              BuiltValueNullFieldError.checkNotNull(bodyId, r'Grant', 'bodyId'),
          subjectPersonId: BuiltValueNullFieldError.checkNotNull(
              subjectPersonId, r'Grant', 'subjectPersonId'),
          grantKind: BuiltValueNullFieldError.checkNotNull(
              grantKind, r'Grant', 'grantKind'),
          key: BuiltValueNullFieldError.checkNotNull(key, r'Grant', 'key'),
          resourceKind: resourceKind,
          resourceId: resourceId,
          validFrom: BuiltValueNullFieldError.checkNotNull(
              validFrom, r'Grant', 'validFrom'),
          validUntil: validUntil,
          granterKind: BuiltValueNullFieldError.checkNotNull(
              granterKind, r'Grant', 'granterKind'),
          source_: BuiltValueNullFieldError.checkNotNull(
              source_, r'Grant', 'source_'),
          state:
              BuiltValueNullFieldError.checkNotNull(state, r'Grant', 'state'),
          revokedAt: revokedAt,
          revokeReason: revokeReason,
          rowVersion: BuiltValueNullFieldError.checkNotNull(
              rowVersion, r'Grant', 'rowVersion'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
