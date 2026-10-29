// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'written.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$Written extends Written {
  @override
  final String id;
  @override
  final int rowVersion;

  factory _$Written([void Function(WrittenBuilder)? updates]) =>
      (WrittenBuilder()..update(updates))._build();

  _$Written._({required this.id, required this.rowVersion}) : super._();
  @override
  Written rebuild(void Function(WrittenBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  WrittenBuilder toBuilder() => WrittenBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Written && id == other.id && rowVersion == other.rowVersion;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, rowVersion.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Written')
          ..add('id', id)
          ..add('rowVersion', rowVersion))
        .toString();
  }
}

class WrittenBuilder implements Builder<Written, WrittenBuilder> {
  _$Written? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  int? _rowVersion;
  int? get rowVersion => _$this._rowVersion;
  set rowVersion(int? rowVersion) => _$this._rowVersion = rowVersion;

  WrittenBuilder() {
    Written._defaults(this);
  }

  WrittenBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _rowVersion = $v.rowVersion;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Written other) {
    _$v = other as _$Written;
  }

  @override
  void update(void Function(WrittenBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Written build() => _build();

  _$Written _build() {
    final _$result = _$v ??
        _$Written._(
          id: BuiltValueNullFieldError.checkNotNull(id, r'Written', 'id'),
          rowVersion: BuiltValueNullFieldError.checkNotNull(
              rowVersion, r'Written', 'rowVersion'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
