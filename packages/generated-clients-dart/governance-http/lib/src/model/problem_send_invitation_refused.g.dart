// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_send_invitation_refused.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemSendInvitationRefused extends ProblemSendInvitationRefused {
  @override
  final OneOf oneOf;

  factory _$ProblemSendInvitationRefused(
          [void Function(ProblemSendInvitationRefusedBuilder)? updates]) =>
      (ProblemSendInvitationRefusedBuilder()..update(updates))._build();

  _$ProblemSendInvitationRefused._({required this.oneOf}) : super._();
  @override
  ProblemSendInvitationRefused rebuild(
          void Function(ProblemSendInvitationRefusedBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemSendInvitationRefusedBuilder toBuilder() =>
      ProblemSendInvitationRefusedBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemSendInvitationRefused && oneOf == other.oneOf;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, oneOf.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ProblemSendInvitationRefused')
          ..add('oneOf', oneOf))
        .toString();
  }
}

class ProblemSendInvitationRefusedBuilder
    implements
        Builder<ProblemSendInvitationRefused,
            ProblemSendInvitationRefusedBuilder> {
  _$ProblemSendInvitationRefused? _$v;

  OneOf? _oneOf;
  OneOf? get oneOf => _$this._oneOf;
  set oneOf(OneOf? oneOf) => _$this._oneOf = oneOf;

  ProblemSendInvitationRefusedBuilder() {
    ProblemSendInvitationRefused._defaults(this);
  }

  ProblemSendInvitationRefusedBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _oneOf = $v.oneOf;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ProblemSendInvitationRefused other) {
    _$v = other as _$ProblemSendInvitationRefused;
  }

  @override
  void update(void Function(ProblemSendInvitationRefusedBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemSendInvitationRefused build() => _build();

  _$ProblemSendInvitationRefused _build() {
    final _$result = _$v ??
        _$ProblemSendInvitationRefused._(
          oneOf: BuiltValueNullFieldError.checkNotNull(
              oneOf, r'ProblemSendInvitationRefused', 'oneOf'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
