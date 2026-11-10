//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/api_users_get200_response_data_inner.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_users_get200_response.g.dart';

/// ApiUsersGet200Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiUsersGet200Response implements Built<ApiUsersGet200Response, ApiUsersGet200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  @BuiltValueField(wireName: r'data')
  BuiltList<ApiUsersGet200ResponseDataInner> get data;

  ApiUsersGet200Response._();

  factory ApiUsersGet200Response([void updates(ApiUsersGet200ResponseBuilder b)]) = _$ApiUsersGet200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiUsersGet200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiUsersGet200Response> get serializer => _$ApiUsersGet200ResponseSerializer();
}

class _$ApiUsersGet200ResponseSerializer implements PrimitiveSerializer<ApiUsersGet200Response> {
  @override
  final Iterable<Type> types = const [ApiUsersGet200Response, _$ApiUsersGet200Response];

  @override
  final String wireName = r'ApiUsersGet200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiUsersGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'success';
    yield serializers.serialize(
      object.success,
      specifiedType: const FullType(bool),
    );
    yield r'data';
    yield serializers.serialize(
      object.data,
      specifiedType: const FullType(BuiltList, [FullType(ApiUsersGet200ResponseDataInner)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiUsersGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiUsersGet200ResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'success':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.success = valueDes;
          break;
        case r'data':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(ApiUsersGet200ResponseDataInner)]),
          ) as BuiltList<ApiUsersGet200ResponseDataInner>;
          result.data.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiUsersGet200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiUsersGet200ResponseBuilder();
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

