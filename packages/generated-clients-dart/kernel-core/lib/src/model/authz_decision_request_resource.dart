//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'authz_decision_request_resource.g.dart';

/// AuthzDecisionRequestResource
///
/// Properties:
/// * [kind] 
/// * [id] 
@BuiltValue()
abstract class AuthzDecisionRequestResource implements Built<AuthzDecisionRequestResource, AuthzDecisionRequestResourceBuilder> {
  @BuiltValueField(wireName: r'kind')
  String get kind;

  @BuiltValueField(wireName: r'id')
  String get id;

  AuthzDecisionRequestResource._();

  factory AuthzDecisionRequestResource([void updates(AuthzDecisionRequestResourceBuilder b)]) = _$AuthzDecisionRequestResource;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AuthzDecisionRequestResourceBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AuthzDecisionRequestResource> get serializer => _$AuthzDecisionRequestResourceSerializer();
}

class _$AuthzDecisionRequestResourceSerializer implements PrimitiveSerializer<AuthzDecisionRequestResource> {
  @override
  final Iterable<Type> types = const [AuthzDecisionRequestResource, _$AuthzDecisionRequestResource];

  @override
  final String wireName = r'AuthzDecisionRequestResource';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AuthzDecisionRequestResource object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'kind';
    yield serializers.serialize(
      object.kind,
      specifiedType: const FullType(String),
    );
    yield r'id';
    yield serializers.serialize(
      object.id,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    AuthzDecisionRequestResource object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AuthzDecisionRequestResourceBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'kind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.kind = valueDes;
          break;
        case r'id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.id = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  AuthzDecisionRequestResource deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AuthzDecisionRequestResourceBuilder();
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

