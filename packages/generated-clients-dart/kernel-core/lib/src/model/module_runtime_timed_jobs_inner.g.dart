// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'module_runtime_timed_jobs_inner.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ModuleRuntimeTimedJobsInner extends ModuleRuntimeTimedJobsInner {
  @override
  final String id;
  @override
  final bool activeColourOnly;

  factory _$ModuleRuntimeTimedJobsInner(
          [void Function(ModuleRuntimeTimedJobsInnerBuilder)? updates]) =>
      (ModuleRuntimeTimedJobsInnerBuilder()..update(updates))._build();

  _$ModuleRuntimeTimedJobsInner._(
      {required this.id, required this.activeColourOnly})
      : super._();
  @override
  ModuleRuntimeTimedJobsInner rebuild(
          void Function(ModuleRuntimeTimedJobsInnerBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ModuleRuntimeTimedJobsInnerBuilder toBuilder() =>
      ModuleRuntimeTimedJobsInnerBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ModuleRuntimeTimedJobsInner &&
        id == other.id &&
        activeColourOnly == other.activeColourOnly;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, activeColourOnly.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ModuleRuntimeTimedJobsInner')
          ..add('id', id)
          ..add('activeColourOnly', activeColourOnly))
        .toString();
  }
}

class ModuleRuntimeTimedJobsInnerBuilder
    implements
        Builder<ModuleRuntimeTimedJobsInner,
            ModuleRuntimeTimedJobsInnerBuilder> {
  _$ModuleRuntimeTimedJobsInner? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  bool? _activeColourOnly;
  bool? get activeColourOnly => _$this._activeColourOnly;
  set activeColourOnly(bool? activeColourOnly) =>
      _$this._activeColourOnly = activeColourOnly;

  ModuleRuntimeTimedJobsInnerBuilder() {
    ModuleRuntimeTimedJobsInner._defaults(this);
  }

  ModuleRuntimeTimedJobsInnerBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _activeColourOnly = $v.activeColourOnly;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ModuleRuntimeTimedJobsInner other) {
    _$v = other as _$ModuleRuntimeTimedJobsInner;
  }

  @override
  void update(void Function(ModuleRuntimeTimedJobsInnerBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ModuleRuntimeTimedJobsInner build() => _build();

  _$ModuleRuntimeTimedJobsInner _build() {
    final _$result = _$v ??
        _$ModuleRuntimeTimedJobsInner._(
          id: BuiltValueNullFieldError.checkNotNull(
              id, r'ModuleRuntimeTimedJobsInner', 'id'),
          activeColourOnly: BuiltValueNullFieldError.checkNotNull(
              activeColourOnly,
              r'ModuleRuntimeTimedJobsInner',
              'activeColourOnly'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
