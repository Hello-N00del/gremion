// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'tenancy_self.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$TenancySelf extends TenancySelf {
  @override
  final String customerId;
  @override
  final String slug;
  @override
  final String realm;

  factory _$TenancySelf([void Function(TenancySelfBuilder)? updates]) =>
      (TenancySelfBuilder()..update(updates))._build();

  _$TenancySelf._(
      {required this.customerId, required this.slug, required this.realm})
      : super._();
  @override
  TenancySelf rebuild(void Function(TenancySelfBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  TenancySelfBuilder toBuilder() => TenancySelfBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is TenancySelf &&
        customerId == other.customerId &&
        slug == other.slug &&
        realm == other.realm;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, customerId.hashCode);
    _$hash = $jc(_$hash, slug.hashCode);
    _$hash = $jc(_$hash, realm.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'TenancySelf')
          ..add('customerId', customerId)
          ..add('slug', slug)
          ..add('realm', realm))
        .toString();
  }
}

class TenancySelfBuilder implements Builder<TenancySelf, TenancySelfBuilder> {
  _$TenancySelf? _$v;

  String? _customerId;
  String? get customerId => _$this._customerId;
  set customerId(String? customerId) => _$this._customerId = customerId;

  String? _slug;
  String? get slug => _$this._slug;
  set slug(String? slug) => _$this._slug = slug;

  String? _realm;
  String? get realm => _$this._realm;
  set realm(String? realm) => _$this._realm = realm;

  TenancySelfBuilder() {
    TenancySelf._defaults(this);
  }

  TenancySelfBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _customerId = $v.customerId;
      _slug = $v.slug;
      _realm = $v.realm;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(TenancySelf other) {
    _$v = other as _$TenancySelf;
  }

  @override
  void update(void Function(TenancySelfBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  TenancySelf build() => _build();

  _$TenancySelf _build() {
    final _$result = _$v ??
        _$TenancySelf._(
          customerId: BuiltValueNullFieldError.checkNotNull(
              customerId, r'TenancySelf', 'customerId'),
          slug: BuiltValueNullFieldError.checkNotNull(
              slug, r'TenancySelf', 'slug'),
          realm: BuiltValueNullFieldError.checkNotNull(
              realm, r'TenancySelf', 'realm'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
