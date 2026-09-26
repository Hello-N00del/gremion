// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_no_mail_connector.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemNoMailConnector extends ProblemNoMailConnector {
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

  factory _$ProblemNoMailConnector(
          [void Function(ProblemNoMailConnectorBuilder)? updates]) =>
      (ProblemNoMailConnectorBuilder()..update(updates))._build();

  _$ProblemNoMailConnector._(
      {required this.type,
      required this.title,
      required this.status,
      this.detail,
      this.instance})
      : super._();
  @override
  ProblemNoMailConnector rebuild(
          void Function(ProblemNoMailConnectorBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemNoMailConnectorBuilder toBuilder() =>
      ProblemNoMailConnectorBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemNoMailConnector &&
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
    return (newBuiltValueToStringHelper(r'ProblemNoMailConnector')
          ..add('type', type)
          ..add('title', title)
          ..add('status', status)
          ..add('detail', detail)
          ..add('instance', instance))
        .toString();
  }
}

class ProblemNoMailConnectorBuilder
    implements Builder<ProblemNoMailConnector, ProblemNoMailConnectorBuilder> {
  _$ProblemNoMailConnector? _$v;

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

  ProblemNoMailConnectorBuilder() {
    ProblemNoMailConnector._defaults(this);
  }

  ProblemNoMailConnectorBuilder get _$this {
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
  void replace(ProblemNoMailConnector other) {
    _$v = other as _$ProblemNoMailConnector;
  }

  @override
  void update(void Function(ProblemNoMailConnectorBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemNoMailConnector build() => _build();

  _$ProblemNoMailConnector _build() {
    final _$result = _$v ??
        _$ProblemNoMailConnector._(
          type: BuiltValueNullFieldError.checkNotNull(
              type, r'ProblemNoMailConnector', 'type'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'ProblemNoMailConnector', 'title'),
          status: BuiltValueNullFieldError.checkNotNull(
              status, r'ProblemNoMailConnector', 'status'),
          detail: detail,
          instance: instance,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
