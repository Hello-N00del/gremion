// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'module_runtime.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ModuleRuntime extends ModuleRuntime {
  @override
  final String version;
  @override
  final ModuleRuntimeDatabase? database;
  @override
  final ModuleRuntimeExport? export_;
  @override
  final BuiltList<ModuleRuntimeTimedJobsInner> timedJobs;
  @override
  final ModuleRuntimePlatformServer? platformServer;

  factory _$ModuleRuntime([void Function(ModuleRuntimeBuilder)? updates]) =>
      (ModuleRuntimeBuilder()..update(updates))._build();

  _$ModuleRuntime._(
      {required this.version,
      this.database,
      this.export_,
      required this.timedJobs,
      this.platformServer})
      : super._();
  @override
  ModuleRuntime rebuild(void Function(ModuleRuntimeBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ModuleRuntimeBuilder toBuilder() => ModuleRuntimeBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ModuleRuntime &&
        version == other.version &&
        database == other.database &&
        export_ == other.export_ &&
        timedJobs == other.timedJobs &&
        platformServer == other.platformServer;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, version.hashCode);
    _$hash = $jc(_$hash, database.hashCode);
    _$hash = $jc(_$hash, export_.hashCode);
    _$hash = $jc(_$hash, timedJobs.hashCode);
    _$hash = $jc(_$hash, platformServer.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ModuleRuntime')
          ..add('version', version)
          ..add('database', database)
          ..add('export_', export_)
          ..add('timedJobs', timedJobs)
          ..add('platformServer', platformServer))
        .toString();
  }
}

class ModuleRuntimeBuilder
    implements Builder<ModuleRuntime, ModuleRuntimeBuilder> {
  _$ModuleRuntime? _$v;

  String? _version;
  String? get version => _$this._version;
  set version(String? version) => _$this._version = version;

  ModuleRuntimeDatabaseBuilder? _database;
  ModuleRuntimeDatabaseBuilder get database =>
      _$this._database ??= ModuleRuntimeDatabaseBuilder();
  set database(ModuleRuntimeDatabaseBuilder? database) =>
      _$this._database = database;

  ModuleRuntimeExportBuilder? _export_;
  ModuleRuntimeExportBuilder get export_ =>
      _$this._export_ ??= ModuleRuntimeExportBuilder();
  set export_(ModuleRuntimeExportBuilder? export_) => _$this._export_ = export_;

  ListBuilder<ModuleRuntimeTimedJobsInner>? _timedJobs;
  ListBuilder<ModuleRuntimeTimedJobsInner> get timedJobs =>
      _$this._timedJobs ??= ListBuilder<ModuleRuntimeTimedJobsInner>();
  set timedJobs(ListBuilder<ModuleRuntimeTimedJobsInner>? timedJobs) =>
      _$this._timedJobs = timedJobs;

  ModuleRuntimePlatformServerBuilder? _platformServer;
  ModuleRuntimePlatformServerBuilder get platformServer =>
      _$this._platformServer ??= ModuleRuntimePlatformServerBuilder();
  set platformServer(ModuleRuntimePlatformServerBuilder? platformServer) =>
      _$this._platformServer = platformServer;

  ModuleRuntimeBuilder() {
    ModuleRuntime._defaults(this);
  }

  ModuleRuntimeBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _version = $v.version;
      _database = $v.database?.toBuilder();
      _export_ = $v.export_?.toBuilder();
      _timedJobs = $v.timedJobs.toBuilder();
      _platformServer = $v.platformServer?.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ModuleRuntime other) {
    _$v = other as _$ModuleRuntime;
  }

  @override
  void update(void Function(ModuleRuntimeBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ModuleRuntime build() => _build();

  _$ModuleRuntime _build() {
    _$ModuleRuntime _$result;
    try {
      _$result = _$v ??
          _$ModuleRuntime._(
            version: BuiltValueNullFieldError.checkNotNull(
                version, r'ModuleRuntime', 'version'),
            database: _database?.build(),
            export_: _export_?.build(),
            timedJobs: timedJobs.build(),
            platformServer: _platformServer?.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'database';
        _database?.build();
        _$failedField = 'export_';
        _export_?.build();
        _$failedField = 'timedJobs';
        timedJobs.build();
        _$failedField = 'platformServer';
        _platformServer?.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ModuleRuntime', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
