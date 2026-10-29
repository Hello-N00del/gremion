// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'seat_list.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$SeatList extends SeatList {
  @override
  final String bodyId;
  @override
  final BuiltList<Seat> seats;

  factory _$SeatList([void Function(SeatListBuilder)? updates]) =>
      (SeatListBuilder()..update(updates))._build();

  _$SeatList._({required this.bodyId, required this.seats}) : super._();
  @override
  SeatList rebuild(void Function(SeatListBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  SeatListBuilder toBuilder() => SeatListBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is SeatList && bodyId == other.bodyId && seats == other.seats;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, seats.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'SeatList')
          ..add('bodyId', bodyId)
          ..add('seats', seats))
        .toString();
  }
}

class SeatListBuilder implements Builder<SeatList, SeatListBuilder> {
  _$SeatList? _$v;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  ListBuilder<Seat>? _seats;
  ListBuilder<Seat> get seats => _$this._seats ??= ListBuilder<Seat>();
  set seats(ListBuilder<Seat>? seats) => _$this._seats = seats;

  SeatListBuilder() {
    SeatList._defaults(this);
  }

  SeatListBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _bodyId = $v.bodyId;
      _seats = $v.seats.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(SeatList other) {
    _$v = other as _$SeatList;
  }

  @override
  void update(void Function(SeatListBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  SeatList build() => _build();

  _$SeatList _build() {
    _$SeatList _$result;
    try {
      _$result = _$v ??
          _$SeatList._(
            bodyId: BuiltValueNullFieldError.checkNotNull(
                bodyId, r'SeatList', 'bodyId'),
            seats: seats.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'seats';
        seats.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'SeatList', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
