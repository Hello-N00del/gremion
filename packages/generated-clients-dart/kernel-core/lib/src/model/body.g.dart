// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'body.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const BodyStateEnum _$bodyStateEnum_active = const BodyStateEnum._('active');
const BodyStateEnum _$bodyStateEnum_archived =
    const BodyStateEnum._('archived');
const BodyStateEnum _$bodyStateEnum_unknownDefaultOpenApi =
    const BodyStateEnum._('unknownDefaultOpenApi');

BodyStateEnum _$bodyStateEnumValueOf(String name) {
  switch (name) {
    case 'active':
      return _$bodyStateEnum_active;
    case 'archived':
      return _$bodyStateEnum_archived;
    case 'unknownDefaultOpenApi':
      return _$bodyStateEnum_unknownDefaultOpenApi;
    default:
      return _$bodyStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<BodyStateEnum> _$bodyStateEnumValues =
    BuiltSet<BodyStateEnum>(const <BodyStateEnum>[
  _$bodyStateEnum_active,
  _$bodyStateEnum_archived,
  _$bodyStateEnum_unknownDefaultOpenApi,
]);

Serializer<BodyStateEnum> _$bodyStateEnumSerializer =
    _$BodyStateEnumSerializer();

class _$BodyStateEnumSerializer implements PrimitiveSerializer<BodyStateEnum> {
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
  final Iterable<Type> types = const <Type>[BodyStateEnum];
  @override
  final String wireName = 'BodyStateEnum';

  @override
  Object serialize(Serializers serializers, BodyStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  BodyStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      BodyStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Body extends Body {
  @override
  final String bodyId;
  @override
  final String kindKey;
  @override
  final String name;
  @override
  final String? shortName;
  @override
  final String? parentBodyId;
  @override
  final BodyStateEnum state;
  @override
  final DateTime? archivedAt;
  @override
  final int rowVersion;

  factory _$Body([void Function(BodyBuilder)? updates]) =>
      (BodyBuilder()..update(updates))._build();

  _$Body._(
      {required this.bodyId,
      required this.kindKey,
      required this.name,
      this.shortName,
      this.parentBodyId,
      required this.state,
      this.archivedAt,
      required this.rowVersion})
      : super._();
  @override
  Body rebuild(void Function(BodyBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  BodyBuilder toBuilder() => BodyBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Body &&
        bodyId == other.bodyId &&
        kindKey == other.kindKey &&
        name == other.name &&
        shortName == other.shortName &&
        parentBodyId == other.parentBodyId &&
        state == other.state &&
        archivedAt == other.archivedAt &&
        rowVersion == other.rowVersion;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, kindKey.hashCode);
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, shortName.hashCode);
    _$hash = $jc(_$hash, parentBodyId.hashCode);
    _$hash = $jc(_$hash, state.hashCode);
    _$hash = $jc(_$hash, archivedAt.hashCode);
    _$hash = $jc(_$hash, rowVersion.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Body')
          ..add('bodyId', bodyId)
          ..add('kindKey', kindKey)
          ..add('name', name)
          ..add('shortName', shortName)
          ..add('parentBodyId', parentBodyId)
          ..add('state', state)
          ..add('archivedAt', archivedAt)
          ..add('rowVersion', rowVersion))
        .toString();
  }
}

class BodyBuilder implements Builder<Body, BodyBuilder> {
  _$Body? _$v;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  String? _kindKey;
  String? get kindKey => _$this._kindKey;
  set kindKey(String? kindKey) => _$this._kindKey = kindKey;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  String? _shortName;
  String? get shortName => _$this._shortName;
  set shortName(String? shortName) => _$this._shortName = shortName;

  String? _parentBodyId;
  String? get parentBodyId => _$this._parentBodyId;
  set parentBodyId(String? parentBodyId) => _$this._parentBodyId = parentBodyId;

  BodyStateEnum? _state;
  BodyStateEnum? get state => _$this._state;
  set state(BodyStateEnum? state) => _$this._state = state;

  DateTime? _archivedAt;
  DateTime? get archivedAt => _$this._archivedAt;
  set archivedAt(DateTime? archivedAt) => _$this._archivedAt = archivedAt;

  int? _rowVersion;
  int? get rowVersion => _$this._rowVersion;
  set rowVersion(int? rowVersion) => _$this._rowVersion = rowVersion;

  BodyBuilder() {
    Body._defaults(this);
  }

  BodyBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _bodyId = $v.bodyId;
      _kindKey = $v.kindKey;
      _name = $v.name;
      _shortName = $v.shortName;
      _parentBodyId = $v.parentBodyId;
      _state = $v.state;
      _archivedAt = $v.archivedAt;
      _rowVersion = $v.rowVersion;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Body other) {
    _$v = other as _$Body;
  }

  @override
  void update(void Function(BodyBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Body build() => _build();

  _$Body _build() {
    final _$result = _$v ??
        _$Body._(
          bodyId:
              BuiltValueNullFieldError.checkNotNull(bodyId, r'Body', 'bodyId'),
          kindKey: BuiltValueNullFieldError.checkNotNull(
              kindKey, r'Body', 'kindKey'),
          name: BuiltValueNullFieldError.checkNotNull(name, r'Body', 'name'),
          shortName: shortName,
          parentBodyId: parentBodyId,
          state: BuiltValueNullFieldError.checkNotNull(state, r'Body', 'state'),
          archivedAt: archivedAt,
          rowVersion: BuiltValueNullFieldError.checkNotNull(
              rowVersion, r'Body', 'rowVersion'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
