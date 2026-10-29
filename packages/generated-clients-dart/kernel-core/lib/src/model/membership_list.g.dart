// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'membership_list.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MembershipList extends MembershipList {
  @override
  final String bodyId;
  @override
  final Date asOf;
  @override
  final BuiltList<Membership> memberships;

  factory _$MembershipList([void Function(MembershipListBuilder)? updates]) =>
      (MembershipListBuilder()..update(updates))._build();

  _$MembershipList._(
      {required this.bodyId, required this.asOf, required this.memberships})
      : super._();
  @override
  MembershipList rebuild(void Function(MembershipListBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MembershipListBuilder toBuilder() => MembershipListBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MembershipList &&
        bodyId == other.bodyId &&
        asOf == other.asOf &&
        memberships == other.memberships;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, asOf.hashCode);
    _$hash = $jc(_$hash, memberships.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'MembershipList')
          ..add('bodyId', bodyId)
          ..add('asOf', asOf)
          ..add('memberships', memberships))
        .toString();
  }
}

class MembershipListBuilder
    implements Builder<MembershipList, MembershipListBuilder> {
  _$MembershipList? _$v;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  Date? _asOf;
  Date? get asOf => _$this._asOf;
  set asOf(Date? asOf) => _$this._asOf = asOf;

  ListBuilder<Membership>? _memberships;
  ListBuilder<Membership> get memberships =>
      _$this._memberships ??= ListBuilder<Membership>();
  set memberships(ListBuilder<Membership>? memberships) =>
      _$this._memberships = memberships;

  MembershipListBuilder() {
    MembershipList._defaults(this);
  }

  MembershipListBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _bodyId = $v.bodyId;
      _asOf = $v.asOf;
      _memberships = $v.memberships.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MembershipList other) {
    _$v = other as _$MembershipList;
  }

  @override
  void update(void Function(MembershipListBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MembershipList build() => _build();

  _$MembershipList _build() {
    _$MembershipList _$result;
    try {
      _$result = _$v ??
          _$MembershipList._(
            bodyId: BuiltValueNullFieldError.checkNotNull(
                bodyId, r'MembershipList', 'bodyId'),
            asOf: BuiltValueNullFieldError.checkNotNull(
                asOf, r'MembershipList', 'asOf'),
            memberships: memberships.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'memberships';
        memberships.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'MembershipList', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
