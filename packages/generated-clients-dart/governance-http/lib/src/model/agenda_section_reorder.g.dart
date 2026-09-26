// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'agenda_section_reorder.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$AgendaSectionReorder extends AgendaSectionReorder {
  @override
  final int position;

  factory _$AgendaSectionReorder(
          [void Function(AgendaSectionReorderBuilder)? updates]) =>
      (AgendaSectionReorderBuilder()..update(updates))._build();

  _$AgendaSectionReorder._({required this.position}) : super._();
  @override
  AgendaSectionReorder rebuild(
          void Function(AgendaSectionReorderBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  AgendaSectionReorderBuilder toBuilder() =>
      AgendaSectionReorderBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is AgendaSectionReorder && position == other.position;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, position.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'AgendaSectionReorder')
          ..add('position', position))
        .toString();
  }
}

class AgendaSectionReorderBuilder
    implements Builder<AgendaSectionReorder, AgendaSectionReorderBuilder> {
  _$AgendaSectionReorder? _$v;

  int? _position;
  int? get position => _$this._position;
  set position(int? position) => _$this._position = position;

  AgendaSectionReorderBuilder() {
    AgendaSectionReorder._defaults(this);
  }

  AgendaSectionReorderBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _position = $v.position;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(AgendaSectionReorder other) {
    _$v = other as _$AgendaSectionReorder;
  }

  @override
  void update(void Function(AgendaSectionReorderBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  AgendaSectionReorder build() => _build();

  _$AgendaSectionReorder _build() {
    final _$result = _$v ??
        _$AgendaSectionReorder._(
          position: BuiltValueNullFieldError.checkNotNull(
              position, r'AgendaSectionReorder', 'position'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
