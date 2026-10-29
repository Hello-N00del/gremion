// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'enabled_module.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$EnabledModule extends EnabledModule {
  @override
  final String moduleKey;
  @override
  final String semver;
  @override
  final ModuleRuntime runtime;

  factory _$EnabledModule([void Function(EnabledModuleBuilder)? updates]) =>
      (EnabledModuleBuilder()..update(updates))._build();

  _$EnabledModule._(
      {required this.moduleKey, required this.semver, required this.runtime})
      : super._();
  @override
  EnabledModule rebuild(void Function(EnabledModuleBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  EnabledModuleBuilder toBuilder() => EnabledModuleBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is EnabledModule &&
        moduleKey == other.moduleKey &&
        semver == other.semver &&
        runtime == other.runtime;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, moduleKey.hashCode);
    _$hash = $jc(_$hash, semver.hashCode);
    _$hash = $jc(_$hash, runtime.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'EnabledModule')
          ..add('moduleKey', moduleKey)
          ..add('semver', semver)
          ..add('runtime', runtime))
        .toString();
  }
}

class EnabledModuleBuilder
    implements Builder<EnabledModule, EnabledModuleBuilder> {
  _$EnabledModule? _$v;

  String? _moduleKey;
  String? get moduleKey => _$this._moduleKey;
  set moduleKey(String? moduleKey) => _$this._moduleKey = moduleKey;

  String? _semver;
  String? get semver => _$this._semver;
  set semver(String? semver) => _$this._semver = semver;

  ModuleRuntimeBuilder? _runtime;
  ModuleRuntimeBuilder get runtime =>
      _$this._runtime ??= ModuleRuntimeBuilder();
  set runtime(ModuleRuntimeBuilder? runtime) => _$this._runtime = runtime;

  EnabledModuleBuilder() {
    EnabledModule._defaults(this);
  }

  EnabledModuleBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _moduleKey = $v.moduleKey;
      _semver = $v.semver;
      _runtime = $v.runtime.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(EnabledModule other) {
    _$v = other as _$EnabledModule;
  }

  @override
  void update(void Function(EnabledModuleBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  EnabledModule build() => _build();

  _$EnabledModule _build() {
    _$EnabledModule _$result;
    try {
      _$result = _$v ??
          _$EnabledModule._(
            moduleKey: BuiltValueNullFieldError.checkNotNull(
                moduleKey, r'EnabledModule', 'moduleKey'),
            semver: BuiltValueNullFieldError.checkNotNull(
                semver, r'EnabledModule', 'semver'),
            runtime: runtime.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'runtime';
        runtime.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'EnabledModule', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
