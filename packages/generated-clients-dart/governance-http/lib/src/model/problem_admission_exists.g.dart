// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_admission_exists.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemAdmissionExists extends ProblemAdmissionExists {
  @override
  final String type;
  @override
  final String title;
  @override
  final int status;
  @override
  final String? detail;
  @override
  final String? instance;

  factory _$ProblemAdmissionExists(
          [void Function(ProblemAdmissionExistsBuilder)? updates]) =>
      (ProblemAdmissionExistsBuilder()..update(updates))._build();

  _$ProblemAdmissionExists._(
      {required this.type,
      required this.title,
      required this.status,
      this.detail,
      this.instance})
      : super._();
  @override
  ProblemAdmissionExists rebuild(
          void Function(ProblemAdmissionExistsBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemAdmissionExistsBuilder toBuilder() =>
      ProblemAdmissionExistsBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemAdmissionExists &&
        type == other.type &&
        title == other.title &&
        status == other.status &&
        detail == other.detail &&
        instance == other.instance;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, type.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, status.hashCode);
    _$hash = $jc(_$hash, detail.hashCode);
    _$hash = $jc(_$hash, instance.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ProblemAdmissionExists')
          ..add('type', type)
          ..add('title', title)
          ..add('status', status)
          ..add('detail', detail)
          ..add('instance', instance))
        .toString();
  }
}

class ProblemAdmissionExistsBuilder
    implements Builder<ProblemAdmissionExists, ProblemAdmissionExistsBuilder> {
  _$ProblemAdmissionExists? _$v;

  String? _type;
  String? get type => _$this._type;
  set type(String? type) => _$this._type = type;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  int? _status;
  int? get status => _$this._status;
  set status(int? status) => _$this._status = status;

  String? _detail;
  String? get detail => _$this._detail;
  set detail(String? detail) => _$this._detail = detail;

  String? _instance;
  String? get instance => _$this._instance;
  set instance(String? instance) => _$this._instance = instance;

  ProblemAdmissionExistsBuilder() {
    ProblemAdmissionExists._defaults(this);
  }

  ProblemAdmissionExistsBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _type = $v.type;
      _title = $v.title;
      _status = $v.status;
      _detail = $v.detail;
      _instance = $v.instance;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ProblemAdmissionExists other) {
    _$v = other as _$ProblemAdmissionExists;
  }

  @override
  void update(void Function(ProblemAdmissionExistsBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemAdmissionExists build() => _build();

  _$ProblemAdmissionExists _build() {
    final _$result = _$v ??
        _$ProblemAdmissionExists._(
          type: BuiltValueNullFieldError.checkNotNull(
              type, r'ProblemAdmissionExists', 'type'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'ProblemAdmissionExists', 'title'),
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'ProblemAdmissionExists', 'status'),
          detail: detail,
          instance: instance,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
