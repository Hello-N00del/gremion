// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_governance_committees_id_delete207_response_data.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGovernanceCommitteesIdDelete207ResponseData
    extends ApiGovernanceCommitteesIdDelete207ResponseData {
  @override
  final ProvisioningReport report;

  factory _$ApiGovernanceCommitteesIdDelete207ResponseData(
          [void Function(ApiGovernanceCommitteesIdDelete207ResponseDataBuilder)?
              updates]) =>
      (ApiGovernanceCommitteesIdDelete207ResponseDataBuilder()..update(updates))
          ._build();

  _$ApiGovernanceCommitteesIdDelete207ResponseData._({required this.report})
      : super._();
  @override
  ApiGovernanceCommitteesIdDelete207ResponseData rebuild(
          void Function(ApiGovernanceCommitteesIdDelete207ResponseDataBuilder)
              updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGovernanceCommitteesIdDelete207ResponseDataBuilder toBuilder() =>
      ApiGovernanceCommitteesIdDelete207ResponseDataBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGovernanceCommitteesIdDelete207ResponseData &&
        report == other.report;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, report.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(
            r'ApiGovernanceCommitteesIdDelete207ResponseData')
          ..add('report', report))
        .toString();
  }
}

class ApiGovernanceCommitteesIdDelete207ResponseDataBuilder
    implements
        Builder<ApiGovernanceCommitteesIdDelete207ResponseData,
            ApiGovernanceCommitteesIdDelete207ResponseDataBuilder> {
  _$ApiGovernanceCommitteesIdDelete207ResponseData? _$v;

  ProvisioningReportBuilder? _report;
  ProvisioningReportBuilder get report =>
      _$this._report ??= ProvisioningReportBuilder();
  set report(ProvisioningReportBuilder? report) => _$this._report = report;

  ApiGovernanceCommitteesIdDelete207ResponseDataBuilder() {
    ApiGovernanceCommitteesIdDelete207ResponseData._defaults(this);
  }

  ApiGovernanceCommitteesIdDelete207ResponseDataBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _report = $v.report.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGovernanceCommitteesIdDelete207ResponseData other) {
    _$v = other as _$ApiGovernanceCommitteesIdDelete207ResponseData;
  }

  @override
  void update(
      void Function(ApiGovernanceCommitteesIdDelete207ResponseDataBuilder)?
          updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGovernanceCommitteesIdDelete207ResponseData build() => _build();

  _$ApiGovernanceCommitteesIdDelete207ResponseData _build() {
    _$ApiGovernanceCommitteesIdDelete207ResponseData _$result;
    try {
      _$result = _$v ??
          _$ApiGovernanceCommitteesIdDelete207ResponseData._(
            report: report.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'report';
        report.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGovernanceCommitteesIdDelete207ResponseData',
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
