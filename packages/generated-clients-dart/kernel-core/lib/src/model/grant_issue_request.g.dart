// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'grant_issue_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const GrantIssueRequestGrantKindEnum _$grantIssueRequestGrantKindEnum_role =
    const GrantIssueRequestGrantKindEnum._('role');
const GrantIssueRequestGrantKindEnum
    _$grantIssueRequestGrantKindEnum_capability =
    const GrantIssueRequestGrantKindEnum._('capability');
const GrantIssueRequestGrantKindEnum
    _$grantIssueRequestGrantKindEnum_unknownDefaultOpenApi =
    const GrantIssueRequestGrantKindEnum._('unknownDefaultOpenApi');

GrantIssueRequestGrantKindEnum _$grantIssueRequestGrantKindEnumValueOf(
    String name) {
  switch (name) {
    case 'role':
      return _$grantIssueRequestGrantKindEnum_role;
    case 'capability':
      return _$grantIssueRequestGrantKindEnum_capability;
    case 'unknownDefaultOpenApi':
      return _$grantIssueRequestGrantKindEnum_unknownDefaultOpenApi;
    default:
      return _$grantIssueRequestGrantKindEnum_unknownDefaultOpenApi;
  }
}

final BuiltSet<GrantIssueRequestGrantKindEnum>
    _$grantIssueRequestGrantKindEnumValues = BuiltSet<
        GrantIssueRequestGrantKindEnum>(const <GrantIssueRequestGrantKindEnum>[
  _$grantIssueRequestGrantKindEnum_role,
  _$grantIssueRequestGrantKindEnum_capability,
  _$grantIssueRequestGrantKindEnum_unknownDefaultOpenApi,
]);

Serializer<GrantIssueRequestGrantKindEnum>
    _$grantIssueRequestGrantKindEnumSerializer =
    _$GrantIssueRequestGrantKindEnumSerializer();

class _$GrantIssueRequestGrantKindEnumSerializer
    implements PrimitiveSerializer<GrantIssueRequestGrantKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'role': 'role',
    'capability': 'capability',
    'unknownDefaultOpenApi': 'unknown_default_open_api',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'role': 'role',
    'capability': 'capability',
    'unknown_default_open_api': 'unknownDefaultOpenApi',
  };

  @override
  final Iterable<Type> types = const <Type>[GrantIssueRequestGrantKindEnum];
  @override
  final String wireName = 'GrantIssueRequestGrantKindEnum';

  @override
  Object serialize(
          Serializers serializers, GrantIssueRequestGrantKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  GrantIssueRequestGrantKindEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      GrantIssueRequestGrantKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$GrantIssueRequest extends GrantIssueRequest {
  @override
  final String bodyId;
  @override
  final String subjectPersonId;
  @override
  final GrantIssueRequestGrantKindEnum grantKind;
  @override
  final String key;
  @override
  final String granterRole;
  @override
  final AuthzDecisionRequestResource? resource;
  @override
  final DateTime? validFrom;
  @override
  final DateTime? validUntil;

  factory _$GrantIssueRequest(
          [void Function(GrantIssueRequestBuilder)? updates]) =>
      (GrantIssueRequestBuilder()..update(updates))._build();

  _$GrantIssueRequest._(
      {required this.bodyId,
      required this.subjectPersonId,
      required this.grantKind,
      required this.key,
      required this.granterRole,
      this.resource,
      this.validFrom,
      this.validUntil})
      : super._();
  @override
  GrantIssueRequest rebuild(void Function(GrantIssueRequestBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  GrantIssueRequestBuilder toBuilder() =>
      GrantIssueRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is GrantIssueRequest &&
        bodyId == other.bodyId &&
        subjectPersonId == other.subjectPersonId &&
        grantKind == other.grantKind &&
        key == other.key &&
        granterRole == other.granterRole &&
        resource == other.resource &&
        validFrom == other.validFrom &&
        validUntil == other.validUntil;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, bodyId.hashCode);
    _$hash = $jc(_$hash, subjectPersonId.hashCode);
    _$hash = $jc(_$hash, grantKind.hashCode);
    _$hash = $jc(_$hash, key.hashCode);
    _$hash = $jc(_$hash, granterRole.hashCode);
    _$hash = $jc(_$hash, resource.hashCode);
    _$hash = $jc(_$hash, validFrom.hashCode);
    _$hash = $jc(_$hash, validUntil.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'GrantIssueRequest')
          ..add('bodyId', bodyId)
          ..add('subjectPersonId', subjectPersonId)
          ..add('grantKind', grantKind)
          ..add('key', key)
          ..add('granterRole', granterRole)
          ..add('resource', resource)
          ..add('validFrom', validFrom)
          ..add('validUntil', validUntil))
        .toString();
  }
}

class GrantIssueRequestBuilder
    implements Builder<GrantIssueRequest, GrantIssueRequestBuilder> {
  _$GrantIssueRequest? _$v;

  String? _bodyId;
  String? get bodyId => _$this._bodyId;
  set bodyId(String? bodyId) => _$this._bodyId = bodyId;

  String? _subjectPersonId;
  String? get subjectPersonId => _$this._subjectPersonId;
  set subjectPersonId(String? subjectPersonId) =>
      _$this._subjectPersonId = subjectPersonId;

  GrantIssueRequestGrantKindEnum? _grantKind;
  GrantIssueRequestGrantKindEnum? get grantKind => _$this._grantKind;
  set grantKind(GrantIssueRequestGrantKindEnum? grantKind) =>
      _$this._grantKind = grantKind;

  String? _key;
  String? get key => _$this._key;
  set key(String? key) => _$this._key = key;

  String? _granterRole;
  String? get granterRole => _$this._granterRole;
  set granterRole(String? granterRole) => _$this._granterRole = granterRole;

  AuthzDecisionRequestResourceBuilder? _resource;
  AuthzDecisionRequestResourceBuilder get resource =>
      _$this._resource ??= AuthzDecisionRequestResourceBuilder();
  set resource(AuthzDecisionRequestResourceBuilder? resource) =>
      _$this._resource = resource;

  DateTime? _validFrom;
  DateTime? get validFrom => _$this._validFrom;
  set validFrom(DateTime? validFrom) => _$this._validFrom = validFrom;

  DateTime? _validUntil;
  DateTime? get validUntil => _$this._validUntil;
  set validUntil(DateTime? validUntil) => _$this._validUntil = validUntil;

  GrantIssueRequestBuilder() {
    GrantIssueRequest._defaults(this);
  }

  GrantIssueRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _bodyId = $v.bodyId;
      _subjectPersonId = $v.subjectPersonId;
      _grantKind = $v.grantKind;
      _key = $v.key;
      _granterRole = $v.granterRole;
      _resource = $v.resource?.toBuilder();
      _validFrom = $v.validFrom;
      _validUntil = $v.validUntil;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(GrantIssueRequest other) {
    _$v = other as _$GrantIssueRequest;
  }

  @override
  void update(void Function(GrantIssueRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  GrantIssueRequest build() => _build();

  _$GrantIssueRequest _build() {
    _$GrantIssueRequest _$result;
    try {
      _$result = _$v ??
          _$GrantIssueRequest._(
            bodyId: BuiltValueNullFieldError.checkNotNull(
                bodyId, r'GrantIssueRequest', 'bodyId'),
            subjectPersonId: BuiltValueNullFieldError.checkNotNull(
                subjectPersonId, r'GrantIssueRequest', 'subjectPersonId'),
            grantKind: BuiltValueNullFieldError.checkNotNull(
                grantKind, r'GrantIssueRequest', 'grantKind'),
            key: BuiltValueNullFieldError.checkNotNull(
                key, r'GrantIssueRequest', 'key'),
            granterRole: BuiltValueNullFieldError.checkNotNull(
                granterRole, r'GrantIssueRequest', 'granterRole'),
            resource: _resource?.build(),
            validFrom: validFrom,
            validUntil: validUntil,
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'resource';
        _resource?.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'GrantIssueRequest', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
