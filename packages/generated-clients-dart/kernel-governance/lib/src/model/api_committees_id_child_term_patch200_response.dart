//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_committees_id_child_term_patch200_response.g.dart';

/// ApiCommitteesIdChildTermPatch200Response
///
/// Properties:
/// * [childTerm] 
@BuiltValue()
abstract class ApiCommitteesIdChildTermPatch200Response implements Built<ApiCommitteesIdChildTermPatch200Response, ApiCommitteesIdChildTermPatch200ResponseBuilder> {
  @BuiltValueField(wireName: r'child_term')
  String? get childTerm;

  ApiCommitteesIdChildTermPatch200Response._();

  factory ApiCommitteesIdChildTermPatch200Response([void updates(ApiCommitteesIdChildTermPatch200ResponseBuilder b)]) = _$ApiCommitteesIdChildTermPatch200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiCommitteesIdChildTermPatch200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiCommitteesIdChildTermPatch200Response> get serializer => _$ApiCommitteesIdChildTermPatch200ResponseSerializer();
}

class _$ApiCommitteesIdChildTermPatch200ResponseSerializer implements PrimitiveSerializer<ApiCommitteesIdChildTermPatch200Response> {
  @override
  final Iterable<Type> types = const [ApiCommitteesIdChildTermPatch200Response, _$ApiCommitteesIdChildTermPatch200Response];

  @override
  final String wireName = r'ApiCommitteesIdChildTermPatch200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiCommitteesIdChildTermPatch200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'child_term';
    yield object.childTerm == null ? null : serializers.serialize(
      object.childTerm,
      specifiedType: const FullType.nullable(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiCommitteesIdChildTermPatch200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiCommitteesIdChildTermPatch200ResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'child_term':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.childTerm = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiCommitteesIdChildTermPatch200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiCommitteesIdChildTermPatch200ResponseBuilder();
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

