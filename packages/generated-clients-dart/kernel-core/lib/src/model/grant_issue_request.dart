//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/authz_decision_request_resource.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'grant_issue_request.g.dart';

/// GrantIssueRequest
///
/// Properties:
/// * [bodyId] 
/// * [subjectPersonId] 
/// * [grantKind] 
/// * [key] 
/// * [granterRole] 
/// * [resource] 
/// * [validFrom] 
/// * [validUntil] 
@BuiltValue()
abstract class GrantIssueRequest implements Built<GrantIssueRequest, GrantIssueRequestBuilder> {
  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'subjectPersonId')
  String get subjectPersonId;

  @BuiltValueField(wireName: r'grantKind')
  GrantIssueRequestGrantKindEnum get grantKind;
  // enum grantKindEnum {  role,  capability,  };

  @BuiltValueField(wireName: r'key')
  String get key;

  @BuiltValueField(wireName: r'granterRole')
  String get granterRole;

  @BuiltValueField(wireName: r'resource')
  AuthzDecisionRequestResource? get resource;

  @BuiltValueField(wireName: r'validFrom')
  DateTime? get validFrom;

  @BuiltValueField(wireName: r'validUntil')
  DateTime? get validUntil;

  GrantIssueRequest._();

  factory GrantIssueRequest([void updates(GrantIssueRequestBuilder b)]) = _$GrantIssueRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(GrantIssueRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<GrantIssueRequest> get serializer => _$GrantIssueRequestSerializer();
}

class _$GrantIssueRequestSerializer implements PrimitiveSerializer<GrantIssueRequest> {
  @override
  final Iterable<Type> types = const [GrantIssueRequest, _$GrantIssueRequest];

  @override
  final String wireName = r'GrantIssueRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    GrantIssueRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'subjectPersonId';
    yield serializers.serialize(
      object.subjectPersonId,
      specifiedType: const FullType(String),
    );
    yield r'grantKind';
    yield serializers.serialize(
      object.grantKind,
      specifiedType: const FullType(GrantIssueRequestGrantKindEnum),
    );
    yield r'key';
    yield serializers.serialize(
      object.key,
      specifiedType: const FullType(String),
    );
    yield r'granterRole';
    yield serializers.serialize(
      object.granterRole,
      specifiedType: const FullType(String),
    );
    if (object.resource != null) {
      yield r'resource';
      yield serializers.serialize(
        object.resource,
        specifiedType: const FullType(AuthzDecisionRequestResource),
      );
    }
    if (object.validFrom != null) {
      yield r'validFrom';
      yield serializers.serialize(
        object.validFrom,
        specifiedType: const FullType(DateTime),
      );
    }
    if (object.validUntil != null) {
      yield r'validUntil';
      yield serializers.serialize(
        object.validUntil,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    GrantIssueRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required GrantIssueRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'bodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'subjectPersonId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.subjectPersonId = valueDes;
          break;
        case r'grantKind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(GrantIssueRequestGrantKindEnum),
          ) as GrantIssueRequestGrantKindEnum;
          result.grantKind = valueDes;
          break;
        case r'key':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.key = valueDes;
          break;
        case r'granterRole':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.granterRole = valueDes;
          break;
        case r'resource':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(AuthzDecisionRequestResource),
          ) as AuthzDecisionRequestResource;
          result.resource.replace(valueDes);
          break;
        case r'validFrom':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.validFrom = valueDes;
          break;
        case r'validUntil':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.validUntil = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  GrantIssueRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = GrantIssueRequestBuilder();
    final serializedList = (serialized as Iterable<Object?>).toList();
    final unhandled = <Object?>[];
    _deserializeProperties(
      serializers,
      serialized,
      specifiedType: specifiedType,
      serializedList: serializedList,
      unhandled: unhandled,
      result: result,
    );
    return result.build();
  }
}

class GrantIssueRequestGrantKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'role')
  static const GrantIssueRequestGrantKindEnum role = _$grantIssueRequestGrantKindEnum_role;
  @BuiltValueEnumConst(wireName: r'capability')
  static const GrantIssueRequestGrantKindEnum capability = _$grantIssueRequestGrantKindEnum_capability;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const GrantIssueRequestGrantKindEnum unknownDefaultOpenApi = _$grantIssueRequestGrantKindEnum_unknownDefaultOpenApi;

  static Serializer<GrantIssueRequestGrantKindEnum> get serializer => _$grantIssueRequestGrantKindEnumSerializer;

  const GrantIssueRequestGrantKindEnum._(String name): super(name);

  static BuiltSet<GrantIssueRequestGrantKindEnum> get values => _$grantIssueRequestGrantKindEnumValues;
  static GrantIssueRequestGrantKindEnum valueOf(String name) => _$grantIssueRequestGrantKindEnumValueOf(name);
}

