// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_invitation_already_dispatched.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemInvitationAlreadyDispatched
    extends ProblemInvitationAlreadyDispatched {
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

  factory _$ProblemInvitationAlreadyDispatched(
          [void Function(ProblemInvitationAlreadyDispatchedBuilder)?
              updates]) =>
      (ProblemInvitationAlreadyDispatchedBuilder()..update(updates))._build();

  _$ProblemInvitationAlreadyDispatched._(
      {required this.type,
      required this.title,
      required this.status,
      this.detail,
      this.instance})
      : super._();
  @override
  ProblemInvitationAlreadyDispatched rebuild(
          void Function(ProblemInvitationAlreadyDispatchedBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemInvitationAlreadyDispatchedBuilder toBuilder() =>
      ProblemInvitationAlreadyDispatchedBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemInvitationAlreadyDispatched &&
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
    return (newBuiltValueToStringHelper(r'ProblemInvitationAlreadyDispatched')
          ..add('type', type)
          ..add('title', title)
          ..add('status', status)
          ..add('detail', detail)
          ..add('instance', instance))
        .toString();
  }
}

class ProblemInvitationAlreadyDispatchedBuilder
    implements
        Builder<ProblemInvitationAlreadyDispatched,
            ProblemInvitationAlreadyDispatchedBuilder> {
  _$ProblemInvitationAlreadyDispatched? _$v;

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

  ProblemInvitationAlreadyDispatchedBuilder() {
    ProblemInvitationAlreadyDispatched._defaults(this);
  }

  ProblemInvitationAlreadyDispatchedBuilder get _$this {
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
  void replace(ProblemInvitationAlreadyDispatched other) {
    _$v = other as _$ProblemInvitationAlreadyDispatched;
  }

  @override
  void update(
      void Function(ProblemInvitationAlreadyDispatchedBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemInvitationAlreadyDispatched build() => _build();

  _$ProblemInvitationAlreadyDispatched _build() {
    final _$result = _$v ??
        _$ProblemInvitationAlreadyDispatched._(
          type: BuiltValueNullFieldError.checkNotNull(
              type, r'ProblemInvitationAlreadyDispatched', 'type'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'ProblemInvitationAlreadyDispatched', 'title'),
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'ProblemInvitationAlreadyDispatched', 'status'),
          detail: detail,
          instance: instance,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
