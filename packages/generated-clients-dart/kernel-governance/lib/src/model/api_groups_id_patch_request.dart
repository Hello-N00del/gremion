//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_groups_id_patch_request.g.dart';

/// ApiGroupsIdPatchRequest
///
/// Properties:
/// * [name] 
@BuiltValue()
abstract class ApiGroupsIdPatchRequest implements Built<ApiGroupsIdPatchRequest, ApiGroupsIdPatchRequestBuilder> {
  @BuiltValueField(wireName: r'name')
  String? get name;

  ApiGroupsIdPatchRequest._();

  factory ApiGroupsIdPatchRequest([void updates(ApiGroupsIdPatchRequestBuilder b)]) = _$ApiGroupsIdPatchRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGroupsIdPatchRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGroupsIdPatchRequest> get serializer => _$ApiGroupsIdPatchRequestSerializer();
}

class _$ApiGroupsIdPatchRequestSerializer implements PrimitiveSerializer<ApiGroupsIdPatchRequest> {
  @override
  final Iterable<Type> types = const [ApiGroupsIdPatchRequest, _$ApiGroupsIdPatchRequest];

  @override
  final String wireName = r'ApiGroupsIdPatchRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGroupsIdPatchRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    if (object.name != null) {
      yield r'name';
      yield serializers.serialize(
        object.name,
        specifiedType: const FullType(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGroupsIdPatchRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGroupsIdPatchRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGroupsIdPatchRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGroupsIdPatchRequestBuilder();
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

