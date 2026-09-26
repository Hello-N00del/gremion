// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_groups_post201_response_data.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiGroupsPost201ResponseData extends ApiGroupsPost201ResponseData {
  @override
  final String id;
  @override
  final ProvisioningReport report;

  factory _$ApiGroupsPost201ResponseData(
          [void Function(ApiGroupsPost201ResponseDataBuilder)? updates]) =>
      (ApiGroupsPost201ResponseDataBuilder()..update(updates))._build();

  _$ApiGroupsPost201ResponseData._({required this.id, required this.report})
      : super._();
  @override
  ApiGroupsPost201ResponseData rebuild(
          void Function(ApiGroupsPost201ResponseDataBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiGroupsPost201ResponseDataBuilder toBuilder() =>
      ApiGroupsPost201ResponseDataBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiGroupsPost201ResponseData &&
        id == other.id &&
        report == other.report;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, report.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ApiGroupsPost201ResponseData')
          ..add('id', id)
          ..add('report', report))
        .toString();
  }
}

class ApiGroupsPost201ResponseDataBuilder
    implements
        Builder<ApiGroupsPost201ResponseData,
            ApiGroupsPost201ResponseDataBuilder> {
  _$ApiGroupsPost201ResponseData? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  ProvisioningReportBuilder? _report;
  ProvisioningReportBuilder get report =>
      _$this._report ??= ProvisioningReportBuilder();
  set report(ProvisioningReportBuilder? report) => _$this._report = report;

  ApiGroupsPost201ResponseDataBuilder() {
    ApiGroupsPost201ResponseData._defaults(this);
  }

  ApiGroupsPost201ResponseDataBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _report = $v.report.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiGroupsPost201ResponseData other) {
    _$v = other as _$ApiGroupsPost201ResponseData;
  }

  @override
  void update(void Function(ApiGroupsPost201ResponseDataBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiGroupsPost201ResponseData build() => _build();

  _$ApiGroupsPost201ResponseData _build() {
    _$ApiGroupsPost201ResponseData _$result;
    try {
      _$result = _$v ??
          _$ApiGroupsPost201ResponseData._(
            id: BuiltValueNullFieldError.checkNotNull(
                id, r'ApiGroupsPost201ResponseData', 'id'),
            report: report.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'report';
        report.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'ApiGroupsPost201ResponseData', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
