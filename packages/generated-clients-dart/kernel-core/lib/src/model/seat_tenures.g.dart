// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'seat_tenures.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$SeatTenures extends SeatTenures {
  @override
  final String seatId;
  @override
  final BuiltList<Tenure> tenures;

  factory _$SeatTenures([void Function(SeatTenuresBuilder)? updates]) =>
      (SeatTenuresBuilder()..update(updates))._build();

  _$SeatTenures._({required this.seatId, required this.tenures}) : super._();
  @override
  SeatTenures rebuild(void Function(SeatTenuresBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  SeatTenuresBuilder toBuilder() => SeatTenuresBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is SeatTenures &&
        seatId == other.seatId &&
        tenures == other.tenures;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, seatId.hashCode);
    _$hash = $jc(_$hash, tenures.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'SeatTenures')
          ..add('seatId', seatId)
          ..add('tenures', tenures))
        .toString();
  }
}

class SeatTenuresBuilder implements Builder<SeatTenures, SeatTenuresBuilder> {
  _$SeatTenures? _$v;

  String? _seatId;
  String? get seatId => _$this._seatId;
  set seatId(String? seatId) => _$this._seatId = seatId;

  ListBuilder<Tenure>? _tenures;
  ListBuilder<Tenure> get tenures => _$this._tenures ??= ListBuilder<Tenure>();
  set tenures(ListBuilder<Tenure>? tenures) => _$this._tenures = tenures;

  SeatTenuresBuilder() {
    SeatTenures._defaults(this);
  }

  SeatTenuresBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _seatId = $v.seatId;
      _tenures = $v.tenures.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(SeatTenures other) {
    _$v = other as _$SeatTenures;
  }

  @override
  void update(void Function(SeatTenuresBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  SeatTenures build() => _build();

  _$SeatTenures _build() {
    _$SeatTenures _$result;
    try {
      _$result = _$v ??
          _$SeatTenures._(
            seatId: BuiltValueNullFieldError.checkNotNull(
                seatId, r'SeatTenures', 'seatId'),
            tenures: tenures.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'tenures';
        tenures.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'SeatTenures', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
