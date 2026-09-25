// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'provisioning_report.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const ProvisioningReportOverallEnum _$provisioningReportOverallEnum_ok =
    const ProvisioningReportOverallEnum._('ok');
const ProvisioningReportOverallEnum _$provisioningReportOverallEnum_degraded =
    const ProvisioningReportOverallEnum._('degraded');
const ProvisioningReportOverallEnum _$provisioningReportOverallEnum_failed =
    const ProvisioningReportOverallEnum._('failed');
const ProvisioningReportOverallEnum
    _$provisioningReportOverallEnum_unknownDefaultOpenApi =
    const ProvisioningReportOverallEnum._('unknownDefaultOpenApi');

ProvisioningReportOverallEnum _$provisioningReportOverallEnumValueOf(
    String name) {
  switch (name) {
    case 'ok':
      return _$provisioningReportOverallEnum_ok;
    case 'degraded':
      return _$provisioningReportOverallEnum_degraded;
    case 'failed':
      return _$provisioningReportOverallEnum_failed;
    case 'unknownDefaultOpenApi':
      return _$provisioningReportOverallEnum_unknownDefaultOpenApi;
    default:
      return _$provisioningReportOverallEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<ProvisioningReportOverallEnum>
    _$provisioningReportOverallEnumValues = BuiltSet<
        ProvisioningReportOverallEnum>(const <ProvisioningReportOverallEnum>[
  _$provisioningReportOverallEnum_ok,
  _$provisioningReportOverallEnum_degraded,
  _$provisioningReportOverallEnum_failed,
  _$provisioningReportOverallEnum_unknownDefaultOpenApi,
]);

Serializer<ProvisioningReportOverallEnum>
    _$provisioningReportOverallEnumSerializer =
    _$ProvisioningReportOverallEnumSerializer();

class _$ProvisioningReportOverallEnumSerializer
    implements PrimitiveSerializer<ProvisioningReportOverallEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'ok': 'ok',
    'degraded': 'degraded',
    'failed': 'failed',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'ok': 'ok',
    'degraded': 'degraded',
    'failed': 'failed',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[ProvisioningReportOverallEnum];
  @override
  final String wireName = 'ProvisioningReportOverallEnum';

  @override
  Object serialize(
          Serializers serializers, ProvisioningReportOverallEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  ProvisioningReportOverallEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      ProvisioningReportOverallEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$ProvisioningReport extends ProvisioningReport {
  @override
  final String orgUnitId;
  @override
  final ProvisioningReportOverallEnum overall;
  @override
  final BuiltList<SubsystemResult> subsystems;

  factory _$ProvisioningReport(
          [void Function(ProvisioningReportBuilder)? updates]) =>
      (ProvisioningReportBuilder()..update(updates))._build();

  _$ProvisioningReport._(
      {required this.orgUnitId,
      required this.overall,
      required this.subsystems})
      : super._();
  @override
  ProvisioningReport rebuild(
          void Function(ProvisioningReportBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProvisioningReportBuilder toBuilder() =>
      ProvisioningReportBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProvisioningReport &&
        orgUnitId == other.orgUnitId &&
        overall == other.overall &&
        subsystems == other.subsystems;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, orgUnitId.hashCode);
    _$hash = $jc(_$hash, overall.hashCode);
    _$hash = $jc(_$hash, subsystems.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ProvisioningReport')
          ..add('orgUnitId', orgUnitId)
          ..add('overall', overall)
          ..add('subsystems', subsystems))
        .toString();
  }
}

class ProvisioningReportBuilder
    implements Builder<ProvisioningReport, ProvisioningReportBuilder> {
  _$ProvisioningReport? _$v;

  String? _orgUnitId;
  String? get orgUnitId => _$this._orgUnitId;
  set orgUnitId(String? orgUnitId) => _$this._orgUnitId = orgUnitId;

  ProvisioningReportOverallEnum? _overall;
  ProvisioningReportOverallEnum? get overall => _$this._overall;
  set overall(ProvisioningReportOverallEnum? overall) =>
      _$this._overall = overall;

  ListBuilder<SubsystemResult>? _subsystems;
  ListBuilder<SubsystemResult> get subsystems =>
      _$this._subsystems ??= ListBuilder<SubsystemResult>();
  set subsystems(ListBuilder<SubsystemResult>? subsystems) =>
      _$this._subsystems = subsystems;

  ProvisioningReportBuilder() {
    ProvisioningReport._defaults(this);
  }

  ProvisioningReportBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _orgUnitId = $v.orgUnitId;
      _overall = $v.overall;
      _subsystems = $v.subsystems.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ProvisioningReport other) {
    _$v = other as _$ProvisioningReport;
  }

  @override
  void update(void Function(ProvisioningReportBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProvisioningReport build() => _build();

  _$ProvisioningReport _build() {
    _$ProvisioningReport _$result;
    try {
      _$result = _$v ??
          _$ProvisioningReport._(
            orgUnitId: BuiltValueNullFieldError.checkNotNull(
                orgUnitId, r'ProvisioningReport', 'orgUnitId'),
            overall: BuiltValueNullFieldError.checkNotNull(
                overall, r'ProvisioningReport', 'overall'),
            subsystems: subsystems.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'subsystems';
        subsystems.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ProvisioningReport', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
