// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'motion_create.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MotionCreate extends MotionCreate {
  @override
  final String title;
  @override
  final String motionText;
  @override
  final String? rationale;
  @override
  final String? agendaItemId;

  factory _$MotionCreate([void Function(MotionCreateBuilder)? updates]) =>
      (MotionCreateBuilder()..update(updates))._build();

  _$MotionCreate._(
      {required this.title,
      required this.motionText,
      this.rationale,
      this.agendaItemId})
      : super._();
  @override
  MotionCreate rebuild(void Function(MotionCreateBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MotionCreateBuilder toBuilder() => MotionCreateBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MotionCreate &&
        title == other.title &&
        motionText == other.motionText &&
        rationale == other.rationale &&
        agendaItemId == other.agendaItemId;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, motionText.hashCode);
    _$hash = $jc(_$hash, rationale.hashCode);
    _$hash = $jc(_$hash, agendaItemId.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'MotionCreate')
          ..add('title', title)
          ..add('motionText', motionText)
          ..add('rationale', rationale)
          ..add('agendaItemId', agendaItemId))
        .toString();
  }
}

class MotionCreateBuilder
    implements Builder<MotionCreate, MotionCreateBuilder> {
  _$MotionCreate? _$v;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  String? _motionText;
  String? get motionText => _$this._motionText;
  set motionText(String? motionText) => _$this._motionText = motionText;

  String? _rationale;
  String? get rationale => _$this._rationale;
  set rationale(String? rationale) => _$this._rationale = rationale;

  String? _agendaItemId;
  String? get agendaItemId => _$this._agendaItemId;
  set agendaItemId(String? agendaItemId) => _$this._agendaItemId = agendaItemId;

  MotionCreateBuilder() {
    MotionCreate._defaults(this);
  }

  MotionCreateBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _title = $v.title;
      _motionText = $v.motionText;
      _rationale = $v.rationale;
      _agendaItemId = $v.agendaItemId;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MotionCreate other) {
    _$v = other as _$MotionCreate;
  }

  @override
  void update(void Function(MotionCreateBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MotionCreate build() => _build();

  _$MotionCreate _build() {
    final _$result = _$v ??
        _$MotionCreate._(
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'MotionCreate', 'title'),
          motionText: BuiltValueNullFieldError.checkNotNull(
              motionText, r'MotionCreate', 'motionText'),
          rationale: rationale,
          agendaItemId: agendaItemId,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
