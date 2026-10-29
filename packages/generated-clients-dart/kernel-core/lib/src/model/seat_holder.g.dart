// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'seat_holder.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$SeatHolder extends SeatHolder {
  @override
  final String tenureId;
  @override
  final String personId;
  @override
  final Date startsOn;
  @override
  final Date? plannedEndOn;

  factory _$SeatHolder([void Function(SeatHolderBuilder)? updates]) =>
      (SeatHolderBuilder()..update(updates))._build();

  _$SeatHolder._(
      {required this.tenureId,
      required this.personId,
      required this.startsOn,
      this.plannedEndOn})
      : super._();
  @override
  SeatHolder rebuild(void Function(SeatHolderBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  SeatHolderBuilder toBuilder() => SeatHolderBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is SeatHolder &&
        tenureId == other.tenureId &&
        personId == other.personId &&
        startsOn == other.startsOn &&
        plannedEndOn == other.plannedEndOn;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, tenureId.hashCode);
    _$hash = $jc(_$hash, personId.hashCode);
    _$hash = $jc(_$hash, startsOn.hashCode);
    _$hash = $jc(_$hash, plannedEndOn.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'SeatHolder')
          ..add('tenureId', tenureId)
          ..add('personId', personId)
          ..add('startsOn', startsOn)
          ..add('plannedEndOn', plannedEndOn))
        .toString();
  }
}

class SeatHolderBuilder implements Builder<SeatHolder, SeatHolderBuilder> {
  _$SeatHolder? _$v;

  String? _tenureId;
  String? get tenureId => _$this._tenureId;
  set tenureId(String? tenureId) => _$this._tenureId = tenureId;

  String? _personId;
  String? get personId => _$this._personId;
  set personId(String? personId) => _$this._personId = personId;

  Date? _startsOn;
  Date? get startsOn => _$this._startsOn;
  set startsOn(Date? startsOn) => _$this._startsOn = startsOn;

  Date? _plannedEndOn;
  Date? get plannedEndOn => _$this._plannedEndOn;
  set plannedEndOn(Date? plannedEndOn) => _$this._plannedEndOn = plannedEndOn;

  SeatHolderBuilder() {
    SeatHolder._defaults(this);
  }

  SeatHolderBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _tenureId = $v.tenureId;
      _personId = $v.personId;
      _startsOn = $v.startsOn;
      _plannedEndOn = $v.plannedEndOn;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(SeatHolder other) {
    _$v = other as _$SeatHolder;
  }

  @override
  void update(void Function(SeatHolderBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  SeatHolder build() => _build();

  _$SeatHolder _build() {
    final _$result = _$v ??
        _$SeatHolder._(
          tenureId: BuiltValueNullFieldError.checkNotNull(
              tenureId, r'SeatHolder', 'tenureId'),
          personId: BuiltValueNullFieldError.checkNotNull(
              personId, r'SeatHolder', 'personId'),
          startsOn: BuiltValueNullFieldError.checkNotNull(
              startsOn, r'SeatHolder', 'startsOn'),
          plannedEndOn: plannedEndOn,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
