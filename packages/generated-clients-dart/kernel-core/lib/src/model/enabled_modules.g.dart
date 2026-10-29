// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'enabled_modules.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$EnabledModules extends EnabledModules {
  @override
  final String customerId;
  @override
  final BuiltList<EnabledModule> modules;

  factory _$EnabledModules([void Function(EnabledModulesBuilder)? updates]) =>
      (EnabledModulesBuilder()..update(updates))._build();

  _$EnabledModules._({required this.customerId, required this.modules})
      : super._();
  @override
  EnabledModules rebuild(void Function(EnabledModulesBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  EnabledModulesBuilder toBuilder() => EnabledModulesBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is EnabledModules &&
        customerId == other.customerId &&
        modules == other.modules;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, customerId.hashCode);
    _$hash = $jc(_$hash, modules.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'EnabledModules')
          ..add('customerId', customerId)
          ..add('modules', modules))
        .toString();
  }
}

class EnabledModulesBuilder
    implements Builder<EnabledModules, EnabledModulesBuilder> {
  _$EnabledModules? _$v;

  String? _customerId;
  String? get customerId => _$this._customerId;
  set customerId(String? customerId) => _$this._customerId = customerId;

  ListBuilder<EnabledModule>? _modules;
  ListBuilder<EnabledModule> get modules =>
      _$this._modules ??= ListBuilder<EnabledModule>();
  set modules(ListBuilder<EnabledModule>? modules) => _$this._modules = modules;

  EnabledModulesBuilder() {
    EnabledModules._defaults(this);
  }

  EnabledModulesBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _customerId = $v.customerId;
      _modules = $v.modules.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(EnabledModules other) {
    _$v = other as _$EnabledModules;
  }

  @override
  void update(void Function(EnabledModulesBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  EnabledModules build() => _build();

  _$EnabledModules _build() {
    _$EnabledModules _$result;
    try {
      _$result = _$v ??
          _$EnabledModules._(
            customerId: BuiltValueNullFieldError.checkNotNull(
                customerId, r'EnabledModules', 'customerId'),
            modules: modules.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'modules';
        modules.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'EnabledModules', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
