// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'person.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const PersonAccountStateEnum _$personAccountStateEnum_invited =
    const PersonAccountStateEnum._('invited');
const PersonAccountStateEnum _$personAccountStateEnum_active =
    const PersonAccountStateEnum._('active');
const PersonAccountStateEnum _$personAccountStateEnum_disabled =
    const PersonAccountStateEnum._('disabled');
const PersonAccountStateEnum _$personAccountStateEnum_erased =
    const PersonAccountStateEnum._('erased');
const PersonAccountStateEnum _$personAccountStateEnum_unknownDefaultOpenApi =
    const PersonAccountStateEnum._('unknownDefaultOpenApi');

PersonAccountStateEnum _$personAccountStateEnumValueOf(String name) {
  switch (name) {
    case 'invited':
      return _$personAccountStateEnum_invited;
    case 'active':
      return _$personAccountStateEnum_active;
    case 'disabled':
      return _$personAccountStateEnum_disabled;
    case 'erased':
      return _$personAccountStateEnum_erased;
    case 'unknownDefaultOpenApi':
      return _$personAccountStateEnum_unknownDefaultOpenApi;
    default:
      return _$personAccountStateEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<PersonAccountStateEnum> _$personAccountStateEnumValues =
    BuiltSet<PersonAccountStateEnum>(const <PersonAccountStateEnum>[
  _$personAccountStateEnum_invited,
  _$personAccountStateEnum_active,
  _$personAccountStateEnum_disabled,
  _$personAccountStateEnum_erased,
  _$personAccountStateEnum_unknownDefaultOpenApi,
]);

Serializer<PersonAccountStateEnum> _$personAccountStateEnumSerializer =
    _$PersonAccountStateEnumSerializer();

class _$PersonAccountStateEnumSerializer
    implements PrimitiveSerializer<PersonAccountStateEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'invited': 'invited',
    'active': 'active',
    'disabled': 'disabled',
    'erased': 'erased',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'invited': 'invited',
    'active': 'active',
    'disabled': 'disabled',
    'erased': 'erased',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[PersonAccountStateEnum];
  @override
  final String wireName = 'PersonAccountStateEnum';

  @override
  Object serialize(Serializers serializers, PersonAccountStateEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  PersonAccountStateEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      PersonAccountStateEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$Person extends Person {
  @override
  final String personId;
  @override
  final String? displayName;
  @override
  final String? email;
  @override
  final PersonAccountStateEnum accountState;
  @override
  final String pseudonym;
  @override
  final DateTime invitedAt;
  @override
  final DateTime? activatedAt;

  factory _$Person([void Function(PersonBuilder)? updates]) =>
      (PersonBuilder()..update(updates))._build();

  _$Person._(
      {required this.personId,
      this.displayName,
      this.email,
      required this.accountState,
      required this.pseudonym,
      required this.invitedAt,
      this.activatedAt})
      : super._();
  @override
  Person rebuild(void Function(PersonBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  PersonBuilder toBuilder() => PersonBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is Person &&
        personId == other.personId &&
        displayName == other.displayName &&
        email == other.email &&
        accountState == other.accountState &&
        pseudonym == other.pseudonym &&
        invitedAt == other.invitedAt &&
        activatedAt == other.activatedAt;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, personId.hashCode);
    _$hash = $jc(_$hash, displayName.hashCode);
    _$hash = $jc(_$hash, email.hashCode);
    _$hash = $jc(_$hash, accountState.hashCode);
    _$hash = $jc(_$hash, pseudonym.hashCode);
    _$hash = $jc(_$hash, invitedAt.hashCode);
    _$hash = $jc(_$hash, activatedAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'Person')
          ..add('personId', personId)
          ..add('displayName', displayName)
          ..add('email', email)
          ..add('accountState', accountState)
          ..add('pseudonym', pseudonym)
          ..add('invitedAt', invitedAt)
          ..add('activatedAt', activatedAt))
        .toString();
  }
}

class PersonBuilder implements Builder<Person, PersonBuilder> {
  _$Person? _$v;

  String? _personId;
  String? get personId => _$this._personId;
  set personId(String? personId) => _$this._personId = personId;

  String? _displayName;
  String? get displayName => _$this._displayName;
  set displayName(String? displayName) => _$this._displayName = displayName;

  String? _email;
  String? get email => _$this._email;
  set email(String? email) => _$this._email = email;

  PersonAccountStateEnum? _accountState;
  PersonAccountStateEnum? get accountState => _$this._accountState;
  set accountState(PersonAccountStateEnum? accountState) =>
      _$this._accountState = accountState;

  String? _pseudonym;
  String? get pseudonym => _$this._pseudonym;
  set pseudonym(String? pseudonym) => _$this._pseudonym = pseudonym;

  DateTime? _invitedAt;
  DateTime? get invitedAt => _$this._invitedAt;
  set invitedAt(DateTime? invitedAt) => _$this._invitedAt = invitedAt;

  DateTime? _activatedAt;
  DateTime? get activatedAt => _$this._activatedAt;
  set activatedAt(DateTime? activatedAt) => _$this._activatedAt = activatedAt;

  PersonBuilder() {
    Person._defaults(this);
  }

  PersonBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _personId = $v.personId;
      _displayName = $v.displayName;
      _email = $v.email;
      _accountState = $v.accountState;
      _pseudonym = $v.pseudonym;
      _invitedAt = $v.invitedAt;
      _activatedAt = $v.activatedAt;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(Person other) {
    _$v = other as _$Person;
  }

  @override
  void update(void Function(PersonBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  Person build() => _build();

  _$Person _build() {
    final _$result = _$v ??
        _$Person._(
          personId: BuiltValueNullFieldError.checkNotNull(
              personId, r'Person', 'personId'),
          displayName: displayName,
          email: email,
          accountState: BuiltValueNullFieldError.checkNotNull(
              accountState, r'Person', 'accountState'),
          pseudonym: BuiltValueNullFieldError.checkNotNull(
              pseudonym, r'Person', 'pseudonym'),
          invitedAt: BuiltValueNullFieldError.checkNotNull(
              invitedAt, r'Person', 'invitedAt'),
          activatedAt: activatedAt,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
