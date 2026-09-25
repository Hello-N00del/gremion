// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'org_unit.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const OrgUnitAuthorityEnum _$orgUnitAuthorityEnum_advisory =
    const OrgUnitAuthorityEnum._('advisory');
const OrgUnitAuthorityEnum _$orgUnitAuthorityEnum_deciding =
    const OrgUnitAuthorityEnum._('deciding');

OrgUnitAuthorityEnum _$orgUnitAuthorityEnumValueOf(String name) {
  switch (name) {
    case 'advisory':
      return _$orgUnitAuthorityEnum_advisory;
    case 'deciding':
      return _$orgUnitAuthorityEnum_deciding;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<OrgUnitAuthorityEnum> _$orgUnitAuthorityEnumValues =
    BuiltSet<OrgUnitAuthorityEnum>(const <OrgUnitAuthorityEnum>[
  _$orgUnitAuthorityEnum_advisory,
  _$orgUnitAuthorityEnum_deciding,
]);

const OrgUnitVisibilityEnum _$orgUnitVisibilityEnum_allMembers =
    const OrgUnitVisibilityEnum._('allMembers');
const OrgUnitVisibilityEnum _$orgUnitVisibilityEnum_committeeOnly =
    const OrgUnitVisibilityEnum._('committeeOnly');

OrgUnitVisibilityEnum _$orgUnitVisibilityEnumValueOf(String name) {
  switch (name) {
    case 'allMembers':
      return _$orgUnitVisibilityEnum_allMembers;
    case 'committeeOnly':
      return _$orgUnitVisibilityEnum_committeeOnly;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<OrgUnitVisibilityEnum> _$orgUnitVisibilityEnumValues =
    BuiltSet<OrgUnitVisibilityEnum>(const <OrgUnitVisibilityEnum>[
  _$orgUnitVisibilityEnum_allMembers,
  _$orgUnitVisibilityEnum_committeeOnly,
]);

Serializer<OrgUnitAuthorityEnum> _$orgUnitAuthorityEnumSerializer =
    _$OrgUnitAuthorityEnumSerializer();
Serializer<OrgUnitVisibilityEnum> _$orgUnitVisibilityEnumSerializer =
    _$OrgUnitVisibilityEnumSerializer();

class _$OrgUnitAuthorityEnumSerializer
    implements PrimitiveSerializer<OrgUnitAuthorityEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'advisory': 'advisory',
    'deciding': 'deciding',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'advisory': 'advisory',
    'deciding': 'deciding',
  };

  @override
  final Iterable<Type> types = const <Type>[OrgUnitAuthorityEnum];
  @override
  final String wireName = 'OrgUnitAuthorityEnum';

  @override
  Object serialize(Serializers serializers, OrgUnitAuthorityEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  OrgUnitAuthorityEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      OrgUnitAuthorityEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$OrgUnitVisibilityEnumSerializer
    implements PrimitiveSerializer<OrgUnitVisibilityEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'allMembers': 'all_members',
    'committeeOnly': 'committee_only',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'all_members': 'allMembers',
    'committee_only': 'committeeOnly',
  };

  @override
  final Iterable<Type> types = const <Type>[OrgUnitVisibilityEnum];
  @override
  final String wireName = 'OrgUnitVisibilityEnum';

  @override
  Object serialize(Serializers serializers, OrgUnitVisibilityEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  OrgUnitVisibilityEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      OrgUnitVisibilityEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$OrgUnit extends OrgUnit {
  @override
  final String id;
  @override
  final String? parentId;
  @override
  final String kind;
  @override
  final String name;
  @override
  final String? description;
  @override
  final String? childTerm;
  @override
  final String? kindLabel;
  @override
  final OrgUnitAuthorityEnum authority;
  @override
  final OrgUnitVisibilityEnum visibility;
  @override
  final bool wantsMatrixRoom;
  @override
  final bool wantsNextcloudFolder;
  @override
  final DateTime createdAt;

  factory _$OrgUnit([void Function(OrgUnitBuilder)? updates]) =>
      (OrgUnitBuilder()..update(updates))._build();

  _$OrgUnit._(
      {required this.id,
      this.parentId,
      required this.kind,
      required this.name,
      this.description,
      this.childTerm,
      this.kindLabel,
      required this.authority,
      required this.visibility,
      required this.wantsMatrixRoom,
      required this.wantsNextcloudFolder,
      required this.createdAt})
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
        id == other.id &&
        parentId == other.parentId &&
        kind == other.kind &&
        name == other.name &&
        description == other.description &&
        childTerm == other.childTerm &&
        kindLabel == other.kindLabel &&
        authority == other.authority &&
        visibility == other.visibility &&
        wantsMatrixRoom == other.wantsMatrixRoom &&
        wantsNextcloudFolder == other.wantsNextcloudFolder &&
        createdAt == other.createdAt;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, parentId.hashCode);
    _$hash = $jc(_$hash, kind.hashCode);
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, description.hashCode);
    _$hash = $jc(_$hash, childTerm.hashCode);
    _$hash = $jc(_$hash, kindLabel.hashCode);
    _$hash = $jc(_$hash, authority.hashCode);
    _$hash = $jc(_$hash, visibility.hashCode);
    _$hash = $jc(_$hash, wantsMatrixRoom.hashCode);
    _$hash = $jc(_$hash, wantsNextcloudFolder.hashCode);
    _$hash = $jc(_$hash, createdAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'OrgUnit')
          ..add('id', id)
          ..add('parentId', parentId)
          ..add('kind', kind)
          ..add('name', name)
          ..add('description', description)
          ..add('childTerm', childTerm)
          ..add('kindLabel', kindLabel)
          ..add('authority', authority)
          ..add('visibility', visibility)
          ..add('wantsMatrixRoom', wantsMatrixRoom)
          ..add('wantsNextcloudFolder', wantsNextcloudFolder)
          ..add('createdAt', createdAt))
        .toString();
  }
}

class OrgUnitBuilder implements Builder<OrgUnit, OrgUnitBuilder> {
  _$OrgUnit? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  String? _parentId;
  String? get parentId => _$this._parentId;
  set parentId(String? parentId) => _$this._parentId = parentId;

  String? _kind;
  String? get kind => _$this._kind;
  set kind(String? kind) => _$this._kind = kind;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  String? _description;
  String? get description => _$this._description;
  set description(String? description) => _$this._description = description;

  String? _childTerm;
  String? get childTerm => _$this._childTerm;
  set childTerm(String? childTerm) => _$this._childTerm = childTerm;

  String? _kindLabel;
  String? get kindLabel => _$this._kindLabel;
  set kindLabel(String? kindLabel) => _$this._kindLabel = kindLabel;

  OrgUnitAuthorityEnum? _authority;
  OrgUnitAuthorityEnum? get authority => _$this._authority;
  set authority(OrgUnitAuthorityEnum? authority) =>
      _$this._authority = authority;

  OrgUnitVisibilityEnum? _visibility;
  OrgUnitVisibilityEnum? get visibility => _$this._visibility;
  set visibility(OrgUnitVisibilityEnum? visibility) =>
      _$this._visibility = visibility;

  bool? _wantsMatrixRoom;
  bool? get wantsMatrixRoom => _$this._wantsMatrixRoom;
  set wantsMatrixRoom(bool? wantsMatrixRoom) =>
      _$this._wantsMatrixRoom = wantsMatrixRoom;

  bool? _wantsNextcloudFolder;
  bool? get wantsNextcloudFolder => _$this._wantsNextcloudFolder;
  set wantsNextcloudFolder(bool? wantsNextcloudFolder) =>
      _$this._wantsNextcloudFolder = wantsNextcloudFolder;

  DateTime? _createdAt;
  DateTime? get createdAt => _$this._createdAt;
  set createdAt(DateTime? createdAt) => _$this._createdAt = createdAt;

  OrgUnitBuilder() {
    OrgUnit._defaults(this);
  }

  OrgUnitBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _parentId = $v.parentId;
      _kind = $v.kind;
      _name = $v.name;
      _description = $v.description;
      _childTerm = $v.childTerm;
      _kindLabel = $v.kindLabel;
      _authority = $v.authority;
      _visibility = $v.visibility;
      _wantsMatrixRoom = $v.wantsMatrixRoom;
      _wantsNextcloudFolder = $v.wantsNextcloudFolder;
      _createdAt = $v.createdAt;
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
          id: BuiltValueNullFieldError.checkNotNull(id, r'OrgUnit', 'id'),
          parentId: parentId,
          kind: BuiltValueNullFieldError.checkNotNull(kind, r'OrgUnit', 'kind'),
          name: BuiltValueNullFieldError.checkNotNull(name, r'OrgUnit', 'name'),
          description: description,
          childTerm: childTerm,
          kindLabel: kindLabel,
          authority: BuiltValueNullFieldError.checkNotNull(
              authority, r'OrgUnit', 'authority'),
          visibility: BuiltValueNullFieldError.checkNotNull(
              visibility, r'OrgUnit', 'visibility'),
          wantsMatrixRoom: BuiltValueNullFieldError.checkNotNull(
              wantsMatrixRoom, r'OrgUnit', 'wantsMatrixRoom'),
          wantsNextcloudFolder: BuiltValueNullFieldError.checkNotNull(
              wantsNextcloudFolder, r'OrgUnit', 'wantsNextcloudFolder'),
          createdAt: BuiltValueNullFieldError.checkNotNull(
              createdAt, r'OrgUnit', 'createdAt'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
