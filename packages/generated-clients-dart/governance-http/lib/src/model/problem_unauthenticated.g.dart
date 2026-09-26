// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_unauthenticated.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemUnauthenticated extends ProblemUnauthenticated {
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

  factory _$ProblemUnauthenticated(
          [void Function(ProblemUnauthenticatedBuilder)? updates]) =>
      (ProblemUnauthenticatedBuilder()..update(updates))._build();

  _$ProblemUnauthenticated._(
      {required this.type,
      required this.title,
      required this.status,
      this.detail,
      this.instance})
      : super._();
  @override
  ProblemUnauthenticated rebuild(
          void Function(ProblemUnauthenticatedBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemUnauthenticatedBuilder toBuilder() =>
      ProblemUnauthenticatedBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemUnauthenticated &&
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
    return (newBuiltValueToStringHelper(r'ProblemUnauthenticated')
          ..add('type', type)
          ..add('title', title)
          ..add('status', status)
          ..add('detail', detail)
          ..add('instance', instance))
        .toString();
  }
}

class ProblemUnauthenticatedBuilder
    implements Builder<ProblemUnauthenticated, ProblemUnauthenticatedBuilder> {
  _$ProblemUnauthenticated? _$v;

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

  ProblemUnauthenticatedBuilder() {
    ProblemUnauthenticated._defaults(this);
  }

  ProblemUnauthenticatedBuilder get _$this {
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
  void replace(ProblemUnauthenticated other) {
    _$v = other as _$ProblemUnauthenticated;
  }

  @override
  void update(void Function(ProblemUnauthenticatedBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemUnauthenticated build() => _build();

  _$ProblemUnauthenticated _build() {
    final _$result = _$v ??
        _$ProblemUnauthenticated._(
          type: BuiltValueNullFieldError.checkNotNull(
              type, r'ProblemUnauthenticated', 'type'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'ProblemUnauthenticated', 'title'),
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'ProblemUnauthenticated', 'status'),
          detail: detail,
          instance: instance,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
