// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$Problem extends Problem {
  @override
  final String type;
  @override
  final String title;
  @override
  final int status;
  @override
  final String? detail;

  factory _$Problem([void Function(ProblemBuilder)? updates]) =>
      (ProblemBuilder()..update(updates))._build();

  _$Problem._(
      {required this.type,
      required this.title,
      required this.status,
      this.detail})
      : super._();
  @override
  Problem rebuild(void Function(ProblemBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemBuilder toBuilder() => ProblemBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Problem &&
        type == other.type &&
        title == other.title &&
        status == other.status &&
        detail == other.detail;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, type.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, status.hashCode);
    _$hash = $jc(_$hash, detail.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Problem')
          ..add('type', type)
          ..add('title', title)
          ..add('status', status)
          ..add('detail', detail))
        .toString();
  }
}

class ProblemBuilder implements Builder<Problem, ProblemBuilder> {
  _$Problem? _$v;

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

  ProblemBuilder() {
    Problem._defaults(this);
  }

  ProblemBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _type = $v.type;
      _title = $v.title;
      _status = $v.status;
      _detail = $v.detail;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Problem other) {
    _$v = other as _$Problem;
  }

  @override
  void update(void Function(ProblemBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Problem build() => _build();

  _$Problem _build() {
    final _$result = _$v ??
        _$Problem._(
          type: BuiltValueNullFieldError.checkNotNull(type, r'Problem', 'type'),
          title:
              BuiltValueNullFieldError.checkNotNull(title, r'Problem', 'title'),
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'Problem', 'status'),
          detail: detail,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
