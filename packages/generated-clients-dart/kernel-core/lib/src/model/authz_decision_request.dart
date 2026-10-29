//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_core_client/src/model/authz_decision_request_resource.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'authz_decision_request.g.dart';

/// AuthzDecisionRequest
///
/// Properties:
/// * [subject] 
/// * [bodyId] 
/// * [capability] 
/// * [resource] 
@BuiltValue()
abstract class AuthzDecisionRequest implements Built<AuthzDecisionRequest, AuthzDecisionRequestBuilder> {
  @BuiltValueField(wireName: r'subject')
  String get subject;

  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'capability')
  String get capability;

  @BuiltValueField(wireName: r'resource')
  AuthzDecisionRequestResource? get resource;

  AuthzDecisionRequest._();

  factory AuthzDecisionRequest([void updates(AuthzDecisionRequestBuilder b)]) = _$AuthzDecisionRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AuthzDecisionRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AuthzDecisionRequest> get serializer => _$AuthzDecisionRequestSerializer();
}

class _$AuthzDecisionRequestSerializer implements PrimitiveSerializer<AuthzDecisionRequest> {
  @override
  final Iterable<Type> types = const [AuthzDecisionRequest, _$AuthzDecisionRequest];

  @override
  final String wireName = r'AuthzDecisionRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AuthzDecisionRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'subject';
    yield serializers.serialize(
      object.subject,
      specifiedType: const FullType(String),
    );
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'capability';
    yield serializers.serialize(
      object.capability,
      specifiedType: const FullType(String),
    );
    if (object.resource != null) {
      yield r'resource';
      yield serializers.serialize(
        object.resource,
        specifiedType: const FullType(AuthzDecisionRequestResource),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    AuthzDecisionRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AuthzDecisionRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'subject':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.subject = valueDes;
          break;
        case r'bodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'capability':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.capability = valueDes;
          break;
        case r'resource':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(AuthzDecisionRequestResource),
          ) as AuthzDecisionRequestResource;
          result.resource.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  AuthzDecisionRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AuthzDecisionRequestBuilder();
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

