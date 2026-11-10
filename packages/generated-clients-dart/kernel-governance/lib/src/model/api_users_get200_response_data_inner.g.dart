// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api_users_get200_response_data_inner.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$ApiUsersGet200ResponseDataInner
    extends ApiUsersGet200ResponseDataInner {
  @override
  final String id;
  @override
  final String email;
  @override
  final String firstName;
  @override
  final String lastName;
  @override
  final String username;

  factory _$ApiUsersGet200ResponseDataInner(
          [void Function(ApiUsersGet200ResponseDataInnerBuilder)? updates]) =>
      (ApiUsersGet200ResponseDataInnerBuilder()..update(updates))._build();

  _$ApiUsersGet200ResponseDataInner._(
      {required this.id,
      required this.email,
      required this.firstName,
      required this.lastName,
      required this.username})
      : super._();
  @override
  ApiUsersGet200ResponseDataInner rebuild(
          void Function(ApiUsersGet200ResponseDataInnerBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  ApiUsersGet200ResponseDataInnerBuilder toBuilder() =>
      ApiUsersGet200ResponseDataInnerBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is ApiUsersGet200ResponseDataInner &&
        id == other.id &&
        email == other.email &&
        firstName == other.firstName &&
        lastName == other.lastName &&
        username == other.username;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, email.hashCode);
    _$hash = $jc(_$hash, firstName.hashCode);
    _$hash = $jc(_$hash, lastName.hashCode);
    _$hash = $jc(_$hash, username.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'ApiUsersGet200ResponseDataInner')
          ..add('id', id)
          ..add('email', email)
          ..add('firstName', firstName)
          ..add('lastName', lastName)
          ..add('username', username))
        .toString();
  }
}

class ApiUsersGet200ResponseDataInnerBuilder
    implements
        Builder<ApiUsersGet200ResponseDataInner,
            ApiUsersGet200ResponseDataInnerBuilder> {
  _$ApiUsersGet200ResponseDataInner? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  String? _email;
  String? get email => _$this._email;
  set email(String? email) => _$this._email = email;

  String? _firstName;
  String? get firstName => _$this._firstName;
  set firstName(String? firstName) => _$this._firstName = firstName;

  String? _lastName;
  String? get lastName => _$this._lastName;
  set lastName(String? lastName) => _$this._lastName = lastName;

  String? _username;
  String? get username => _$this._username;
  set username(String? username) => _$this._username = username;

  ApiUsersGet200ResponseDataInnerBuilder() {
    ApiUsersGet200ResponseDataInner._defaults(this);
  }

  ApiUsersGet200ResponseDataInnerBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _email = $v.email;
      _firstName = $v.firstName;
      _lastName = $v.lastName;
      _username = $v.username;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(ApiUsersGet200ResponseDataInner other) {
    _$v = other as _$ApiUsersGet200ResponseDataInner;
  }

  @override
  void update(void Function(ApiUsersGet200ResponseDataInnerBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  ApiUsersGet200ResponseDataInner build() => _build();

  _$ApiUsersGet200ResponseDataInner _build() {
    final _$result = _$v ??
        _$ApiUsersGet200ResponseDataInner._(
          id: BuiltValueNullFieldError.checkNotNull(
              id, r'ApiUsersGet200ResponseDataInner', 'id'),
          email: BuiltValueNullFieldError.checkNotNull(
              email, r'ApiUsersGet200ResponseDataInner', 'email'),
          firstName: BuiltValueNullFieldError.checkNotNull(
              firstName, r'ApiUsersGet200ResponseDataInner', 'firstName'),
          lastName: BuiltValueNullFieldError.checkNotNull(
              lastName, r'ApiUsersGet200ResponseDataInner', 'lastName'),
          username: BuiltValueNullFieldError.checkNotNull(
              username, r'ApiUsersGet200ResponseDataInner', 'username'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
