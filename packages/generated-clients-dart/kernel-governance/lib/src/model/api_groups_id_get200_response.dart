//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_groups_id_get200_response.g.dart';

/// ApiGroupsIdGet200Response
///
/// Properties:
/// * [success] 
/// * [data] - Keycloak group object — see kc.getGroup
@BuiltValue()
abstract class ApiGroupsIdGet200Response implements Built<ApiGroupsIdGet200Response, ApiGroupsIdGet200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  JsonObject? get success;

  /// Keycloak group object — see kc.getGroup
  @BuiltValueField(wireName: r'data')
  BuiltMap<String, JsonObject?> get data;

  ApiGroupsIdGet200Response._();

  factory ApiGroupsIdGet200Response([void updates(ApiGroupsIdGet200ResponseBuilder b)]) = _$ApiGroupsIdGet200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGroupsIdGet200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGroupsIdGet200Response> get serializer => _$ApiGroupsIdGet200ResponseSerializer();
}

class _$ApiGroupsIdGet200ResponseSerializer implements PrimitiveSerializer<ApiGroupsIdGet200Response> {
  @override
  final Iterable<Type> types = const [ApiGroupsIdGet200Response, _$ApiGroupsIdGet200Response];

  @override
  final String wireName = r'ApiGroupsIdGet200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGroupsIdGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'success';
    yield object.success == null ? null : serializers.serialize(
      object.success,
      specifiedType: const FullType.nullable(JsonObject),
    );
    yield r'data';
    yield serializers.serialize(
      object.data,
      specifiedType: const FullType(BuiltMap, [FullType(String), FullType.nullable(JsonObject)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGroupsIdGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGroupsIdGet200ResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'success':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(JsonObject),
          ) as JsonObject?;
          if (valueDes == null) continue;
          result.success = valueDes;
          break;
        case r'data':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltMap, [FullType(String), FullType.nullable(JsonObject)]),
          ) as BuiltMap<String, JsonObject?>;
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
  ApiGroupsIdGet200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGroupsIdGet200ResponseBuilder();
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

