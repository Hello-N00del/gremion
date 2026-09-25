//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/api_groups_post201_response_data.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_groups_post201_response.g.dart';

/// ApiGroupsPost201Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGroupsPost201Response implements Built<ApiGroupsPost201Response, ApiGroupsPost201ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  JsonObject? get success;

  @BuiltValueField(wireName: r'data')
  ApiGroupsPost201ResponseData get data;

  ApiGroupsPost201Response._();

  factory ApiGroupsPost201Response([void updates(ApiGroupsPost201ResponseBuilder b)]) = _$ApiGroupsPost201Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGroupsPost201ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGroupsPost201Response> get serializer => _$ApiGroupsPost201ResponseSerializer();
}

class _$ApiGroupsPost201ResponseSerializer implements PrimitiveSerializer<ApiGroupsPost201Response> {
  @override
  final Iterable<Type> types = const [ApiGroupsPost201Response, _$ApiGroupsPost201Response];

  @override
  final String wireName = r'ApiGroupsPost201Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGroupsPost201Response object, {
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
      specifiedType: const FullType(ApiGroupsPost201ResponseData),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGroupsPost201Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGroupsPost201ResponseBuilder result,
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
            specifiedType: const FullType(ApiGroupsPost201ResponseData),
          ) as ApiGroupsPost201ResponseData;
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
  ApiGroupsPost201Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGroupsPost201ResponseBuilder();
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

