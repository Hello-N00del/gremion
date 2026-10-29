// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'body_tree.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$BodyTree extends BodyTree {
  @override
  final BuiltList<Body> bodies;
  @override
  final BuiltList<OrgUnit> orgUnits;

  factory _$BodyTree([void Function(BodyTreeBuilder)? updates]) =>
      (BodyTreeBuilder()..update(updates))._build();

  _$BodyTree._({required this.bodies, required this.orgUnits}) : super._();
  @override
  BodyTree rebuild(void Function(BodyTreeBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  BodyTreeBuilder toBuilder() => BodyTreeBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is BodyTree &&
        bodies == other.bodies &&
        orgUnits == other.orgUnits;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, bodies.hashCode);
    _$hash = $jc(_$hash, orgUnits.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'BodyTree')
          ..add('bodies', bodies)
          ..add('orgUnits', orgUnits))
        .toString();
  }
}

class BodyTreeBuilder implements Builder<BodyTree, BodyTreeBuilder> {
  _$BodyTree? _$v;

  ListBuilder<Body>? _bodies;
  ListBuilder<Body> get bodies => _$this._bodies ??= ListBuilder<Body>();
  set bodies(ListBuilder<Body>? bodies) => _$this._bodies = bodies;

  ListBuilder<OrgUnit>? _orgUnits;
  ListBuilder<OrgUnit> get orgUnits =>
      _$this._orgUnits ??= ListBuilder<OrgUnit>();
  set orgUnits(ListBuilder<OrgUnit>? orgUnits) => _$this._orgUnits = orgUnits;

  BodyTreeBuilder() {
    BodyTree._defaults(this);
  }

  BodyTreeBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _bodies = $v.bodies.toBuilder();
      _orgUnits = $v.orgUnits.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(BodyTree other) {
    _$v = other as _$BodyTree;
  }

  @override
  void update(void Function(BodyTreeBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  BodyTree build() => _build();

  _$BodyTree _build() {
    _$BodyTree _$result;
    try {
      _$result = _$v ??
          _$BodyTree._(
            bodies: bodies.build(),
            orgUnits: orgUnits.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'bodies';
        bodies.build();
        _$failedField = 'orgUnits';
        orgUnits.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'BodyTree', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
