// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_notice_override_conflict.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemNoticeOverrideConflict extends ProblemNoticeOverrideConflict {
  @override
  final OneOf oneOf;

  factory _$ProblemNoticeOverrideConflict(
          [void Function(ProblemNoticeOverrideConflictBuilder)? updates]) =>
      (ProblemNoticeOverrideConflictBuilder()..update(updates))._build();

  _$ProblemNoticeOverrideConflict._({required this.oneOf}) : super._();
  @override
  ProblemNoticeOverrideConflict rebuild(
          void Function(ProblemNoticeOverrideConflictBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemNoticeOverrideConflictBuilder toBuilder() =>
      ProblemNoticeOverrideConflictBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemNoticeOverrideConflict && oneOf == other.oneOf;
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
    return (newBuiltValueToStringHelper(r'ProblemNoticeOverrideConflict')
          ..add('oneOf', oneOf))
        .toString();
  }
}

class ProblemNoticeOverrideConflictBuilder
    implements
        Builder<ProblemNoticeOverrideConflict,
            ProblemNoticeOverrideConflictBuilder> {
  _$ProblemNoticeOverrideConflict? _$v;

  OneOf? _oneOf;
  OneOf? get oneOf => _$this._oneOf;
  set oneOf(OneOf? oneOf) => _$this._oneOf = oneOf;

  ProblemNoticeOverrideConflictBuilder() {
    ProblemNoticeOverrideConflict._defaults(this);
  }

  ProblemNoticeOverrideConflictBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _oneOf = $v.oneOf;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ProblemNoticeOverrideConflict other) {
    _$v = other as _$ProblemNoticeOverrideConflict;
  }

  @override
  void update(void Function(ProblemNoticeOverrideConflictBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemNoticeOverrideConflict build() => _build();

  _$ProblemNoticeOverrideConflict _build() {
    final _$result = _$v ??
        _$ProblemNoticeOverrideConflict._(
          oneOf: BuiltValueNullFieldError.checkNotNull(
              oneOf, r'ProblemNoticeOverrideConflict', 'oneOf'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
