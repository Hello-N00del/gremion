// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invite_person.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$InvitePerson extends InvitePerson {
  @override
  final String email;
  @override
  final String displayName;

  factory _$InvitePerson([void Function(InvitePersonBuilder)? updates]) =>
      (InvitePersonBuilder()..update(updates))._build();

  _$InvitePerson._({required this.email, required this.displayName})
      : super._();
  @override
  InvitePerson rebuild(void Function(InvitePersonBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  InvitePersonBuilder toBuilder() => InvitePersonBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is InvitePerson &&
        email == other.email &&
        displayName == other.displayName;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, email.hashCode);
    _$hash = $jc(_$hash, displayName.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'InvitePerson')
          ..add('email', email)
          ..add('displayName', displayName))
        .toString();
  }
}

class InvitePersonBuilder
    implements Builder<InvitePerson, InvitePersonBuilder> {
  _$InvitePerson? _$v;

  String? _email;
  String? get email => _$this._email;
  set email(String? email) => _$this._email = email;

  String? _displayName;
  String? get displayName => _$this._displayName;
  set displayName(String? displayName) => _$this._displayName = displayName;

  InvitePersonBuilder() {
    InvitePerson._defaults(this);
  }

  InvitePersonBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _email = $v.email;
      _displayName = $v.displayName;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(InvitePerson other) {
    _$v = other as _$InvitePerson;
  }

  @override
  void update(void Function(InvitePersonBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  InvitePerson build() => _build();

  _$InvitePerson _build() {
    final _$result = _$v ??
        _$InvitePerson._(
          email: BuiltValueNullFieldError.checkNotNull(
              email, r'InvitePerson', 'email'),
          displayName: BuiltValueNullFieldError.checkNotNull(
              displayName, r'InvitePerson', 'displayName'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
