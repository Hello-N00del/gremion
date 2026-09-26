// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_state_transition_refused.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemStateTransitionRefused extends ProblemStateTransitionRefused {
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

  factory _$ProblemStateTransitionRefused(
          [void Function(ProblemStateTransitionRefusedBuilder)? updates]) =>
      (ProblemStateTransitionRefusedBuilder()..update(updates))._build();

  _$ProblemStateTransitionRefused._(
      {required this.type,
      required this.title,
      required this.status,
      this.detail,
      this.instance})
      : super._();
  @override
  ProblemStateTransitionRefused rebuild(
          void Function(ProblemStateTransitionRefusedBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemStateTransitionRefusedBuilder toBuilder() =>
      ProblemStateTransitionRefusedBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemStateTransitionRefused &&
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
    return (newBuiltValueToStringHelper(r'ProblemStateTransitionRefused')
          ..add('type', type)
          ..add('title', title)
          ..add('status', status)
          ..add('detail', detail)
          ..add('instance', instance))
        .toString();
  }
}

class ProblemStateTransitionRefusedBuilder
    implements
        Builder<ProblemStateTransitionRefused,
            ProblemStateTransitionRefusedBuilder> {
  _$ProblemStateTransitionRefused? _$v;

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

  ProblemStateTransitionRefusedBuilder() {
    ProblemStateTransitionRefused._defaults(this);
  }

  ProblemStateTransitionRefusedBuilder get _$this {
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
  void replace(ProblemStateTransitionRefused other) {
    _$v = other as _$ProblemStateTransitionRefused;
  }

  @override
  void update(void Function(ProblemStateTransitionRefusedBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemStateTransitionRefused build() => _build();

  _$ProblemStateTransitionRefused _build() {
    final _$result = _$v ??
        _$ProblemStateTransitionRefused._(
          type: BuiltValueNullFieldError.checkNotNull(
              type, r'ProblemStateTransitionRefused', 'type'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'ProblemStateTransitionRefused', 'title'),
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'ProblemStateTransitionRefused', 'status'),
          detail: detail,
          instance: instance,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
