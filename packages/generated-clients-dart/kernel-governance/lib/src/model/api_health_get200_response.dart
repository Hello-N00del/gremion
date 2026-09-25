//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_health_get200_response.g.dart';

/// ApiHealthGet200Response
///
/// Properties:
/// * [status] 
@BuiltValue()
abstract class ApiHealthGet200Response implements Built<ApiHealthGet200Response, ApiHealthGet200ResponseBuilder> {
  @BuiltValueField(wireName: r'status')
  String get status;

  ApiHealthGet200Response._();

  factory ApiHealthGet200Response([void updates(ApiHealthGet200ResponseBuilder b)]) = _$ApiHealthGet200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiHealthGet200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiHealthGet200Response> get serializer => _$ApiHealthGet200ResponseSerializer();
}

class _$ApiHealthGet200ResponseSerializer implements PrimitiveSerializer<ApiHealthGet200Response> {
  @override
  final Iterable<Type> types = const [ApiHealthGet200Response, _$ApiHealthGet200Response];

  @override
  final String wireName = r'ApiHealthGet200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiHealthGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'status';
    yield serializers.serialize(
      object.status,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiHealthGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiHealthGet200ResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'status':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.status = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiHealthGet200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiHealthGet200ResponseBuilder();
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

