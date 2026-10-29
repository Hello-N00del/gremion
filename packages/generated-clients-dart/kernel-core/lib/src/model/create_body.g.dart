// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'create_body.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$CreateBody extends CreateBody {
  @override
  final String kindKey;
  @override
  final String name;
  @override
  final String? shortName;
  @override
  final String? parentBodyId;

  factory _$CreateBody([void Function(CreateBodyBuilder)? updates]) =>
      (CreateBodyBuilder()..update(updates))._build();

  _$CreateBody._(
      {required this.kindKey,
      required this.name,
      this.shortName,
      this.parentBodyId})
      : super._();
  @override
  CreateBody rebuild(void Function(CreateBodyBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  CreateBodyBuilder toBuilder() => CreateBodyBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is CreateBody &&
        kindKey == other.kindKey &&
        name == other.name &&
        shortName == other.shortName &&
        parentBodyId == other.parentBodyId;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, kindKey.hashCode);
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, shortName.hashCode);
    _$hash = $jc(_$hash, parentBodyId.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'CreateBody')
          ..add('kindKey', kindKey)
          ..add('name', name)
          ..add('shortName', shortName)
          ..add('parentBodyId', parentBodyId))
        .toString();
  }
}

class CreateBodyBuilder implements Builder<CreateBody, CreateBodyBuilder> {
  _$CreateBody? _$v;

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

  CreateBodyBuilder() {
    CreateBody._defaults(this);
  }

  CreateBodyBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _kindKey = $v.kindKey;
      _name = $v.name;
      _shortName = $v.shortName;
      _parentBodyId = $v.parentBodyId;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(CreateBody other) {
    _$v = other as _$CreateBody;
  }

  @override
  void update(void Function(CreateBodyBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  CreateBody build() => _build();

  _$CreateBody _build() {
    final _$result = _$v ??
        _$CreateBody._(
          kindKey: BuiltValueNullFieldError.checkNotNull(
              kindKey, r'CreateBody', 'kindKey'),
          name: BuiltValueNullFieldError.checkNotNull(
              name, r'CreateBody', 'name'),
          shortName: shortName,
          parentBodyId: parentBodyId,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
