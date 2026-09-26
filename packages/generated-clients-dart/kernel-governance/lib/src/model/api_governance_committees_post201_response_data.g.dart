// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_post201_response_data.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesPost201ResponseData
    extends ApiGovernanceCommitteesPost201ResponseData {
  @override
  final OrgUnit unit;
  @override
  final ProvisioningReport report;

  factory _$ApiGovernanceCommitteesPost201ResponseData(
          [void Function(ApiGovernanceCommitteesPost201ResponseDataBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesPost201ResponseDataBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesPost201ResponseData._(
      {required this.unit, required this.report})
      : super._();
  @override
  ApiGovernanceCommitteesPost201ResponseData rebuild(
          void Function(ApiGovernanceCommitteesPost201ResponseDataBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesPost201ResponseDataBuilder toBuilder() =>
      ApiGovernanceCommitteesPost201ResponseDataBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesPost201ResponseData &&
        unit == other.unit &&
        report == other.report;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, unit.hashCode);
    _$hash = $jc(_$hash, report.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesPost201ResponseData')
          ..add('unit', unit)
          ..add('report', report))
        .toString();
  }
}

class ApiGovernanceCommitteesPost201ResponseDataBuilder
    implements
        Builder<ApiGovernanceCommitteesPost201ResponseData,
            ApiGovernanceCommitteesPost201ResponseDataBuilder> {
  _$ApiGovernanceCommitteesPost201ResponseData? _$v;

  OrgUnitBuilder? _unit;
  OrgUnitBuilder get unit => _$this._unit ??= OrgUnitBuilder();
  set unit(OrgUnitBuilder? unit) => _$this._unit = unit;

  ProvisioningReportBuilder? _report;
  ProvisioningReportBuilder get report =>
      _$this._report ??= ProvisioningReportBuilder();
  set report(ProvisioningReportBuilder? report) => _$this._report = report;

  ApiGovernanceCommitteesPost201ResponseDataBuilder() {
    ApiGovernanceCommitteesPost201ResponseData._defaults(this);
  }

  ApiGovernanceCommitteesPost201ResponseDataBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _unit = $v.unit.toBuilder();
      _report = $v.report.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesPost201ResponseData other) {
    _$v = other as _$ApiGovernanceCommitteesPost201ResponseData;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesPost201ResponseDataBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesPost201ResponseData build() => _build();

  _$ApiGovernanceCommitteesPost201ResponseData _build() {
    _$ApiGovernanceCommitteesPost201ResponseData _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesPost201ResponseData._(
            unit: unit.build(),
            report: report.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'unit';
        unit.build();
        _$failedField = 'report';
        report.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesPost201ResponseData',
            _$failedField,
            e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
