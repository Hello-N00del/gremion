// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'subsystem_result.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const SubsystemResultSubsystemEnum _$subsystemResultSubsystemEnum_keycloak =
    const SubsystemResultSubsystemEnum._('keycloak');
const SubsystemResultSubsystemEnum _$subsystemResultSubsystemEnum_matrix =
    const SubsystemResultSubsystemEnum._('matrix');
const SubsystemResultSubsystemEnum _$subsystemResultSubsystemEnum_nextcloud =
    const SubsystemResultSubsystemEnum._('nextcloud');
const SubsystemResultSubsystemEnum
    _$subsystemResultSubsystemEnum_unknownDefaultOpenApi =
    const SubsystemResultSubsystemEnum._('unknownDefaultOpenApi');

SubsystemResultSubsystemEnum _$subsystemResultSubsystemEnumValueOf(
    String name) {
  switch (name) {
    case 'keycloak':
      return _$subsystemResultSubsystemEnum_keycloak;
    case 'matrix':
      return _$subsystemResultSubsystemEnum_matrix;
    case 'nextcloud':
      return _$subsystemResultSubsystemEnum_nextcloud;
    case 'unknownDefaultOpenApi':
      return _$subsystemResultSubsystemEnum_unknownDefaultOpenApi;
    default:
      return _$subsystemResultSubsystemEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<SubsystemResultSubsystemEnum>
    _$subsystemResultSubsystemEnumValues =
    BuiltSet<SubsystemResultSubsystemEnum>(const <SubsystemResultSubsystemEnum>[
  _$subsystemResultSubsystemEnum_keycloak,
  _$subsystemResultSubsystemEnum_matrix,
  _$subsystemResultSubsystemEnum_nextcloud,
  _$subsystemResultSubsystemEnum_unknownDefaultOpenApi,
]);

const SubsystemResultStatusEnum _$subsystemResultStatusEnum_ok =
    const SubsystemResultStatusEnum._('ok');
const SubsystemResultStatusEnum _$subsystemResultStatusEnum_failed =
    const SubsystemResultStatusEnum._('failed');
const SubsystemResultStatusEnum _$subsystemResultStatusEnum_skipped =
    const SubsystemResultStatusEnum._('skipped');
const SubsystemResultStatusEnum
    _$subsystemResultStatusEnum_unknownDefaultOpenApi =
    const SubsystemResultStatusEnum._('unknownDefaultOpenApi');

SubsystemResultStatusEnum _$subsystemResultStatusEnumValueOf(String name) {
  switch (name) {
    case 'ok':
      return _$subsystemResultStatusEnum_ok;
    case 'failed':
      return _$subsystemResultStatusEnum_failed;
    case 'skipped':
      return _$subsystemResultStatusEnum_skipped;
    case 'unknownDefaultOpenApi':
      return _$subsystemResultStatusEnum_unknownDefaultOpenApi;
    default:
      return _$subsystemResultStatusEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<SubsystemResultStatusEnum> _$subsystemResultStatusEnumValues =
    BuiltSet<SubsystemResultStatusEnum>(const <SubsystemResultStatusEnum>[
  _$subsystemResultStatusEnum_ok,
  _$subsystemResultStatusEnum_failed,
  _$subsystemResultStatusEnum_skipped,
  _$subsystemResultStatusEnum_unknownDefaultOpenApi,
]);

Serializer<SubsystemResultSubsystemEnum>
    _$subsystemResultSubsystemEnumSerializer =
    _$SubsystemResultSubsystemEnumSerializer();
Serializer<SubsystemResultStatusEnum> _$subsystemResultStatusEnumSerializer =
    _$SubsystemResultStatusEnumSerializer();

class _$SubsystemResultSubsystemEnumSerializer
    implements PrimitiveSerializer<SubsystemResultSubsystemEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'keycloak': 'keycloak',
    'matrix': 'matrix',
    'nextcloud': 'nextcloud',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'keycloak': 'keycloak',
    'matrix': 'matrix',
    'nextcloud': 'nextcloud',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[SubsystemResultSubsystemEnum];
  @override
  final String wireName = 'SubsystemResultSubsystemEnum';

  @override
  Object serialize(Serializers serializers, SubsystemResultSubsystemEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  SubsystemResultSubsystemEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      SubsystemResultSubsystemEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$SubsystemResultStatusEnumSerializer
    implements PrimitiveSerializer<SubsystemResultStatusEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'ok': 'ok',
    'failed': 'failed',
    'skipped': 'skipped',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'ok': 'ok',
    'failed': 'failed',
    'skipped': 'skipped',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[SubsystemResultStatusEnum];
  @override
  final String wireName = 'SubsystemResultStatusEnum';

  @override
  Object serialize(Serializers serializers, SubsystemResultStatusEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  SubsystemResultStatusEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      SubsystemResultStatusEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$SubsystemResult extends SubsystemResult {
  @override
  final SubsystemResultSubsystemEnum subsystem;
  @override
  final SubsystemResultStatusEnum status;
  @override
  final String? error;
  @override
  final bool willRetry;

  factory _$SubsystemResult([void Function(SubsystemResultBuilder)? updates]) =>
      (SubsystemResultBuilder()..update(updates))._build();

  _$SubsystemResult._(
      {required this.subsystem,
      required this.status,
      this.error,
      required this.willRetry})
      : super._();
  @override
  SubsystemResult rebuild(void Function(SubsystemResultBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  SubsystemResultBuilder toBuilder() => SubsystemResultBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is SubsystemResult &&
        subsystem == other.subsystem &&
        status == other.status &&
        error == other.error &&
        willRetry == other.willRetry;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, subsystem.hashCode);
    _$hash = $jc(_$hash, status.hashCode);
    _$hash = $jc(_$hash, error.hashCode);
    _$hash = $jc(_$hash, willRetry.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'SubsystemResult')
          ..add('subsystem', subsystem)
          ..add('status', status)
          ..add('error', error)
          ..add('willRetry', willRetry))
        .toString();
  }
}

class SubsystemResultBuilder
    implements Builder<SubsystemResult, SubsystemResultBuilder> {
  _$SubsystemResult? _$v;

  SubsystemResultSubsystemEnum? _subsystem;
  SubsystemResultSubsystemEnum? get subsystem => _$this._subsystem;
  set subsystem(SubsystemResultSubsystemEnum? subsystem) =>
      _$this._subsystem = subsystem;

  SubsystemResultStatusEnum? _status;
  SubsystemResultStatusEnum? get status => _$this._status;
  set status(SubsystemResultStatusEnum? status) => _$this._status = status;

  String? _error;
  String? get error => _$this._error;
  set error(String? error) => _$this._error = error;

  bool? _willRetry;
  bool? get willRetry => _$this._willRetry;
  set willRetry(bool? willRetry) => _$this._willRetry = willRetry;

  SubsystemResultBuilder() {
    SubsystemResult._defaults(this);
  }

  SubsystemResultBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _subsystem = $v.subsystem;
      _status = $v.status;
      _error = $v.error;
      _willRetry = $v.willRetry;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(SubsystemResult other) {
    _$v = other as _$SubsystemResult;
  }

  @override
  void update(void Function(SubsystemResultBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  SubsystemResult build() => _build();

  _$SubsystemResult _build() {
    final _$result = _$v ??
        _$SubsystemResult._(
          subsystem: BuiltValueNullFieldError.checkNotNull(
              subsystem, r'SubsystemResult', 'subsystem'),
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'SubsystemResult', 'status'),
          error: error,
          willRetry: BuiltValueNullFieldError.checkNotNull(
              willRetry, r'SubsystemResult', 'willRetry'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
