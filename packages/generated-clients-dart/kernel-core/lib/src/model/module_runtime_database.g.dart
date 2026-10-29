// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'module_runtime_database.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ModuleRuntimeDatabase extends ModuleRuntimeDatabase {
  @override
  final String postgresService;
  @override
  final String migrations;

  factory _$ModuleRuntimeDatabase(
          [void Function(ModuleRuntimeDatabaseBuilder)? updates]) =>
      (ModuleRuntimeDatabaseBuilder()..update(updates))._build();

  _$ModuleRuntimeDatabase._(
      {required this.postgresService, required this.migrations})
      : super._();
  @override
  ModuleRuntimeDatabase rebuild(
          void Function(ModuleRuntimeDatabaseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ModuleRuntimeDatabaseBuilder toBuilder() =>
      ModuleRuntimeDatabaseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ModuleRuntimeDatabase &&
        postgresService == other.postgresService &&
        migrations == other.migrations;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, postgresService.hashCode);
    _$hash = $jc(_$hash, migrations.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ModuleRuntimeDatabase')
          ..add('postgresService', postgresService)
          ..add('migrations', migrations))
        .toString();
  }
}

class ModuleRuntimeDatabaseBuilder
    implements Builder<ModuleRuntimeDatabase, ModuleRuntimeDatabaseBuilder> {
  _$ModuleRuntimeDatabase? _$v;

  String? _postgresService;
  String? get postgresService => _$this._postgresService;
  set postgresService(String? postgresService) =>
      _$this._postgresService = postgresService;

  String? _migrations;
  String? get migrations => _$this._migrations;
  set migrations(String? migrations) => _$this._migrations = migrations;

  ModuleRuntimeDatabaseBuilder() {
    ModuleRuntimeDatabase._defaults(this);
  }

  ModuleRuntimeDatabaseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _postgresService = $v.postgresService;
      _migrations = $v.migrations;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ModuleRuntimeDatabase other) {
    _$v = other as _$ModuleRuntimeDatabase;
  }

  @override
  void update(void Function(ModuleRuntimeDatabaseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ModuleRuntimeDatabase build() => _build();

  _$ModuleRuntimeDatabase _build() {
    final _$result = _$v ??
        _$ModuleRuntimeDatabase._(
          postgresService: BuiltValueNullFieldError.checkNotNull(
              postgresService, r'ModuleRuntimeDatabase', 'postgresService'),
          migrations: BuiltValueNullFieldError.checkNotNull(
              migrations, r'ModuleRuntimeDatabase', 'migrations'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
