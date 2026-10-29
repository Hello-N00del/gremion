// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'module_runtime_export.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ModuleRuntimeExport extends ModuleRuntimeExport {
  @override
  final String kind;
  @override
  final String retentionProfile;

  factory _$ModuleRuntimeExport(
          [void Function(ModuleRuntimeExportBuilder)? updates]) =>
      (ModuleRuntimeExportBuilder()..update(updates))._build();

  _$ModuleRuntimeExport._({required this.kind, required this.retentionProfile})
      : super._();
  @override
  ModuleRuntimeExport rebuild(
          void Function(ModuleRuntimeExportBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ModuleRuntimeExportBuilder toBuilder() =>
      ModuleRuntimeExportBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ModuleRuntimeExport &&
        kind == other.kind &&
        retentionProfile == other.retentionProfile;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, kind.hashCode);
    _$hash = $jc(_$hash, retentionProfile.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ModuleRuntimeExport')
          ..add('kind', kind)
          ..add('retentionProfile', retentionProfile))
        .toString();
  }
}

class ModuleRuntimeExportBuilder
    implements Builder<ModuleRuntimeExport, ModuleRuntimeExportBuilder> {
  _$ModuleRuntimeExport? _$v;

  String? _kind;
  String? get kind => _$this._kind;
  set kind(String? kind) => _$this._kind = kind;

  String? _retentionProfile;
  String? get retentionProfile => _$this._retentionProfile;
  set retentionProfile(String? retentionProfile) =>
      _$this._retentionProfile = retentionProfile;

  ModuleRuntimeExportBuilder() {
    ModuleRuntimeExport._defaults(this);
  }

  ModuleRuntimeExportBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _kind = $v.kind;
      _retentionProfile = $v.retentionProfile;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ModuleRuntimeExport other) {
    _$v = other as _$ModuleRuntimeExport;
  }

  @override
  void update(void Function(ModuleRuntimeExportBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ModuleRuntimeExport build() => _build();

  _$ModuleRuntimeExport _build() {
    final _$result = _$v ??
        _$ModuleRuntimeExport._(
          kind: BuiltValueNullFieldError.checkNotNull(
              kind, r'ModuleRuntimeExport', 'kind'),
          retentionProfile: BuiltValueNullFieldError.checkNotNull(
              retentionProfile, r'ModuleRuntimeExport', 'retentionProfile'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
