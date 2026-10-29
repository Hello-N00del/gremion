// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'org_unit.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const OrgUnitStateEnum _$orgUnitStateEnum_active =
    const OrgUnitStateEnum._('active');
const OrgUnitStateEnum _$orgUnitStateEnum_archived =
    const OrgUnitStateEnum._('archived');
const OrgUnitStateEnum _$orgUnitStateEnum_unknownDefaultOpenApi =
    const OrgUnitStateEnum._('unknownDefaultOpenApi');

OrgUnitStateEnum _$orgUnitStateEnumValueOf(String name) {
  switch (name) {
    case 'active':
      return _$orgUnitStateEnum_active;
    case 'archived':
      return _$orgUnitStateEnum_archived;
    case 'unknownDefaultOpenApi':
      return _$orgUnitStateEnum_unknownDefaultOpenApi;
    default:
      return _$orgUnitStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<OrgUnitStateEnum> _$orgUnitStateEnumValues =
    BuiltSet<OrgUnitStateEnum>(const <OrgUnitStateEnum>[
  _$orgUnitStateEnum_active,
  _$orgUnitStateEnum_archived,
  _$orgUnitStateEnum_unknownDefaultOpenApi,
]);

Serializer<OrgUnitStateEnum> _$orgUnitStateEnumSerializer =
    _$OrgUnitStateEnumSerializer();

class _$OrgUnitStateEnumSerializer
    implements PrimitiveSerializer<OrgUnitStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'active': 'active',
    'archived': 'archived',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'active': 'active',
    'archived': 'archived',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[OrgUnitStateEnum];
  @override
  final String wireName = 'OrgUnitStateEnum';

  @override
  Object serialize(Serializers serializers, OrgUnitStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  OrgUnitStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      OrgUnitStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$OrgUnit extends OrgUnit {
  @override
  final String orgUnitId;
  @override
  final String bodyId;
  @override
  final String? parentOrgUnitId;
  @override
  final String kindKey;
  @override
  final String name;
  @override
  final bool isOrgan;
  @override
  final OrgUnitStateEnum state;
  @override
  final int rowVersion;

  factory _$OrgUnit([void Function(OrgUnitBuilder)? updates]) =>
      (OrgUnitBuilder()..update(updates))._build();

  _$OrgUnit._(
      {required this.orgUnitId,
      required this.bodyId,
      this.parentOrgUnitId,
      required this.kindKey,
      required this.name,
      required this.isOrgan,
      required this.state,
      required this.rowVersion})
      : super._();
  @override
  OrgUnit rebuild(void Function(OrgUnitBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  OrgUnitBuilder toBuilder() => OrgUnitBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is OrgUnit &&
        orgUnitId == other.orgUnitId &&
        bodyId == other.bodyId &&
        parentOrgUnitId == other.parentOrgUnitId &&
        kindKey == other.kindKey &&
        name == other.name &&
        isOrgan == other.isOrgan &&
        state == other.state &&
        rowVersion == other.rowVersion;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, parentOrgUnitId.hashCode);
    _$hash = $jc(_$hash, kindKey.hashCode);
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, isOrgan.hashCode);
    _$hash = $jc(_$hash, state.hashCode);
    _$hash = $jc(_$hash, rowVersion.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'OrgUnit')
          ..add('orgUnitId', orgUnitId)
          ..add('bodyId', bodyId)
          ..add('parentOrgUnitId', parentOrgUnitId)
          ..add('kindKey', kindKey)
          ..add('name', name)
          ..add('isOrgan', isOrgan)
          ..add('state', state)
          ..add('rowVersion', rowVersion))
        .toString();
  }
}

class OrgUnitBuilder implements Builder<OrgUnit, OrgUnitBuilder> {
  _$OrgUnit? _$v;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  String? _parentOrgUnitId;
  String? get parentOrgUnitId => _$this._parentOrgUnitId;
  set parentOrgUnitId(String? parentOrgUnitId) =>
      _$this._parentOrgUnitId = parentOrgUnitId;

  String? _kindKey;
  String? get kindKey => _$this._kindKey;
  set kindKey(String? kindKey) => _$this._kindKey = kindKey;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  bool? _isOrgan;
  bool? get isOrgan => _$this._isOrgan;
  set isOrgan(bool? isOrgan) => _$this._isOrgan = isOrgan;

  OrgUnitStateEnum? _state;
  OrgUnitStateEnum? get state => _$this._state;
  set state(OrgUnitStateEnum? state) => _$this._state = state;

  int? _rowVersion;
  int? get rowVersion => _$this._rowVersion;
  set rowVersion(int? rowVersion) => _$this._rowVersion = rowVersion;

  OrgUnitBuilder() {
    OrgUnit._defaults(this);
  }

  OrgUnitBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _orgUnitId = $v.orgUnitId;
      _bodyId = $v.bodyId;
      _parentOrgUnitId = $v.parentOrgUnitId;
      _kindKey = $v.kindKey;
      _name = $v.name;
      _isOrgan = $v.isOrgan;
      _state = $v.state;
      _rowVersion = $v.rowVersion;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(OrgUnit other) {
    _$v = other as _$OrgUnit;
  }

  @override
  void update(void Function(OrgUnitBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  OrgUnit build() => _build();

  _$OrgUnit _build() {
    final _$result = _$v ??
        _$OrgUnit._(
          orgUnitId: BuiltValueNullFieldError.checkNotNull(
              orgUnitId, r'OrgUnit', 'orgUnitId'),
          bodyId: BuiltValueNullFieldError.checkNotNull(
              bodyId, r'OrgUnit', 'bodyId'),
          parentOrgUnitId: parentOrgUnitId,
          kindKey: BuiltValueNullFieldError.checkNotNull(
              kindKey, r'OrgUnit', 'kindKey'),
          name: BuiltValueNullFieldError.checkNotNull(name, r'OrgUnit', 'name'),
          isOrgan: BuiltValueNullFieldError.checkNotNull(
              isOrgan, r'OrgUnit', 'isOrgan'),
          state:
              BuiltValueNullFieldError.checkNotNull(state, r'OrgUnit', 'state'),
          rowVersion: BuiltValueNullFieldError.checkNotNull(
              rowVersion, r'OrgUnit', 'rowVersion'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
