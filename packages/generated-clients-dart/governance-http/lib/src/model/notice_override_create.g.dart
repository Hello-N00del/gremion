// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'notice_override_create.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$NoticeOverrideCreate extends NoticeOverrideCreate {
  @override
  final String reason;
  @override
  final String? curingBasisId;

  factory _$NoticeOverrideCreate(
          [void Function(NoticeOverrideCreateBuilder)? updates]) =>
      (NoticeOverrideCreateBuilder()..update(updates))._build();

  _$NoticeOverrideCreate._({required this.reason, this.curingBasisId})
      : super._();
  @override
  NoticeOverrideCreate rebuild(
          void Function(NoticeOverrideCreateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  NoticeOverrideCreateBuilder toBuilder() =>
      NoticeOverrideCreateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is NoticeOverrideCreate &&
        reason == other.reason &&
        curingBasisId == other.curingBasisId;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, reason.hashCode);
    _$hash = $jc(_$hash, curingBasisId.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'NoticeOverrideCreate')
          ..add('reason', reason)
          ..add('curingBasisId', curingBasisId))
        .toString();
  }
}

class NoticeOverrideCreateBuilder
    implements Builder<NoticeOverrideCreate, NoticeOverrideCreateBuilder> {
  _$NoticeOverrideCreate? _$v;

  String? _reason;
  String? get reason => _$this._reason;
  set reason(String? reason) => _$this._reason = reason;

  String? _curingBasisId;
  String? get curingBasisId => _$this._curingBasisId;
  set curingBasisId(String? curingBasisId) =>
      _$this._curingBasisId = curingBasisId;

  NoticeOverrideCreateBuilder() {
    NoticeOverrideCreate._defaults(this);
  }

  NoticeOverrideCreateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _reason = $v.reason;
      _curingBasisId = $v.curingBasisId;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(NoticeOverrideCreate other) {
    _$v = other as _$NoticeOverrideCreate;
  }

  @override
  void update(void Function(NoticeOverrideCreateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  NoticeOverrideCreate build() => _build();

  _$NoticeOverrideCreate _build() {
    final _$result = _$v ??
        _$NoticeOverrideCreate._(
          reason: BuiltValueNullFieldError.checkNotNull(
              reason, r'NoticeOverrideCreate', 'reason'),
          curingBasisId: curingBasisId,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
