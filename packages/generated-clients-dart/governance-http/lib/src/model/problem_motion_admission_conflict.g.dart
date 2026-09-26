// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'problem_motion_admission_conflict.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ProblemMotionAdmissionConflict extends ProblemMotionAdmissionConflict {
  @override
  final OneOf oneOf;

  factory _$ProblemMotionAdmissionConflict(
          [void Function(ProblemMotionAdmissionConflictBuilder)? updates]) =>
      (ProblemMotionAdmissionConflictBuilder()..update(updates))._build();

  _$ProblemMotionAdmissionConflict._({required this.oneOf}) : super._();
  @override
  ProblemMotionAdmissionConflict rebuild(
          void Function(ProblemMotionAdmissionConflictBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ProblemMotionAdmissionConflictBuilder toBuilder() =>
      ProblemMotionAdmissionConflictBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ProblemMotionAdmissionConflict && oneOf == other.oneOf;
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
    return (newBuiltValueToStringHelper(r'ProblemMotionAdmissionConflict')
          ..add('oneOf', oneOf))
        .toString();
  }
}

class ProblemMotionAdmissionConflictBuilder
    implements
        Builder<ProblemMotionAdmissionConflict,
            ProblemMotionAdmissionConflictBuilder> {
  _$ProblemMotionAdmissionConflict? _$v;

  OneOf? _oneOf;
  OneOf? get oneOf => _$this._oneOf;
  set oneOf(OneOf? oneOf) => _$this._oneOf = oneOf;

  ProblemMotionAdmissionConflictBuilder() {
    ProblemMotionAdmissionConflict._defaults(this);
  }

  ProblemMotionAdmissionConflictBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _oneOf = $v.oneOf;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ProblemMotionAdmissionConflict other) {
    _$v = other as _$ProblemMotionAdmissionConflict;
  }

  @override
  void update(void Function(ProblemMotionAdmissionConflictBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ProblemMotionAdmissionConflict build() => _build();

  _$ProblemMotionAdmissionConflict _build() {
    final _$result = _$v ??
        _$ProblemMotionAdmissionConflict._(
          oneOf: BuiltValueNullFieldError.checkNotNull(
              oneOf, r'ProblemMotionAdmissionConflict', 'oneOf'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
