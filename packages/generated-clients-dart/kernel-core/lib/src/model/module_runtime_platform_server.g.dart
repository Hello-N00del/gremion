// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'module_runtime_platform_server.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ModuleRuntimePlatformServer extends ModuleRuntimePlatformServer {
  @override
  final String postgresService;
  @override
  final BuiltList<String> databases;

  factory _$ModuleRuntimePlatformServer(
          [void Function(ModuleRuntimePlatformServerBuilder)? updates]) =>
      (ModuleRuntimePlatformServerBuilder()..update(updates))._build();

  _$ModuleRuntimePlatformServer._(
      {required this.postgresService, required this.databases})
      : super._();
  @override
  ModuleRuntimePlatformServer rebuild(
          void Function(ModuleRuntimePlatformServerBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ModuleRuntimePlatformServerBuilder toBuilder() =>
      ModuleRuntimePlatformServerBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ModuleRuntimePlatformServer &&
        postgresService == other.postgresService &&
        databases == other.databases;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, postgresService.hashCode);
    _$hash = $jc(_$hash, databases.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ModuleRuntimePlatformServer')
          ..add('postgresService', postgresService)
          ..add('databases', databases))
        .toString();
  }
}

class ModuleRuntimePlatformServerBuilder
    implements
        Builder<ModuleRuntimePlatformServer,
            ModuleRuntimePlatformServerBuilder> {
  _$ModuleRuntimePlatformServer? _$v;

  String? _postgresService;
  String? get postgresService => _$this._postgresService;
  set postgresService(String? postgresService) =>
      _$this._postgresService = postgresService;

  ListBuilder<String>? _databases;
  ListBuilder<String> get databases =>
      _$this._databases ??= ListBuilder<String>();
  set databases(ListBuilder<String>? databases) =>
      _$this._databases = databases;

  ModuleRuntimePlatformServerBuilder() {
    ModuleRuntimePlatformServer._defaults(this);
  }

  ModuleRuntimePlatformServerBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _postgresService = $v.postgresService;
      _databases = $v.databases.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ModuleRuntimePlatformServer other) {
    _$v = other as _$ModuleRuntimePlatformServer;
  }

  @override
  void update(void Function(ModuleRuntimePlatformServerBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ModuleRuntimePlatformServer build() => _build();

  _$ModuleRuntimePlatformServer _build() {
    _$ModuleRuntimePlatformServer _$result;
    try {
      _$result = _$v ??
          _$ModuleRuntimePlatformServer._(
            postgresService: BuiltValueNullFieldError.checkNotNull(
                postgresService,
                r'ModuleRuntimePlatformServer',
                'postgresService'),
            databases: databases.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'databases';
        databases.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ModuleRuntimePlatformServer', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
