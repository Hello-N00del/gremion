//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'authz_decision.g.dart';

/// AuthzDecision
///
/// Properties:
/// * [allow] 
/// * [reason] 
/// * [grantIds] 
@BuiltValue()
abstract class AuthzDecision implements Built<AuthzDecision, AuthzDecisionBuilder> {
  @BuiltValueField(wireName: r'allow')
  bool get allow;

  @BuiltValueField(wireName: r'reason')
  String get reason;

  @BuiltValueField(wireName: r'grantIds')
  BuiltList<String> get grantIds;

  AuthzDecision._();

  factory AuthzDecision([void updates(AuthzDecisionBuilder b)]) = _$AuthzDecision;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AuthzDecisionBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AuthzDecision> get serializer => _$AuthzDecisionSerializer();
}

class _$AuthzDecisionSerializer implements PrimitiveSerializer<AuthzDecision> {
  @override
  final Iterable<Type> types = const [AuthzDecision, _$AuthzDecision];

  @override
  final String wireName = r'AuthzDecision';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AuthzDecision object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'allow';
    yield serializers.serialize(
      object.allow,
      specifiedType: const FullType(bool),
    );
    yield r'reason';
    yield serializers.serialize(
      object.reason,
      specifiedType: const FullType(String),
    );
    yield r'grantIds';
    yield serializers.serialize(
      object.grantIds,
      specifiedType: const FullType(BuiltList, [FullType(String)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    AuthzDecision object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AuthzDecisionBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'allow':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.allow = valueDes;
          break;
        case r'reason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.reason = valueDes;
          break;
        case r'grantIds':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(String)]),
          ) as BuiltList<String>;
          result.grantIds.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  AuthzDecision deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AuthzDecisionBuilder();
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

