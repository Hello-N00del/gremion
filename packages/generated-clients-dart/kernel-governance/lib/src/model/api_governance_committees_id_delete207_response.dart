//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_delete207_response_data.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_delete207_response.g.dart';

/// ApiGovernanceCommitteesIdDelete207Response
///
/// Properties:
/// * [success] 
/// * [error] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdDelete207Response implements Built<ApiGovernanceCommitteesIdDelete207Response, ApiGovernanceCommitteesIdDelete207ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  JsonObject? get success;

  @BuiltValueField(wireName: r'error')
  String get error;

  @BuiltValueField(wireName: r'data')
  ApiGovernanceCommitteesIdDelete207ResponseData get data;

  ApiGovernanceCommitteesIdDelete207Response._();

  factory ApiGovernanceCommitteesIdDelete207Response([void updates(ApiGovernanceCommitteesIdDelete207ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdDelete207Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdDelete207ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdDelete207Response> get serializer => _$ApiGovernanceCommitteesIdDelete207ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdDelete207ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdDelete207Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdDelete207Response, _$ApiGovernanceCommitteesIdDelete207Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdDelete207Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdDelete207Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'success';
    yield object.success == null ? null : serializers.serialize(
      object.success,
      specifiedType: const FullType.nullable(JsonObject),
    );
    yield r'error';
    yield serializers.serialize(
      object.error,
      specifiedType: const FullType(String),
    );
    yield r'data';
    yield serializers.serialize(
      object.data,
      specifiedType: const FullType(ApiGovernanceCommitteesIdDelete207ResponseData),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdDelete207Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdDelete207ResponseBuilder result,
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
        case r'error':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.error = valueDes;
          break;
        case r'data':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ApiGovernanceCommitteesIdDelete207ResponseData),
          ) as ApiGovernanceCommitteesIdDelete207ResponseData;
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
  ApiGovernanceCommitteesIdDelete207Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdDelete207ResponseBuilder();
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

