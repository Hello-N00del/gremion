//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_delete207_response_data.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_members_post201_response.g.dart';

/// ApiGovernanceCommitteesIdMembersPost201Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdMembersPost201Response implements Built<ApiGovernanceCommitteesIdMembersPost201Response, ApiGovernanceCommitteesIdMembersPost201ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  JsonObject? get success;

  @BuiltValueField(wireName: r'data')
  ApiGovernanceCommitteesIdDelete207ResponseData get data;

  ApiGovernanceCommitteesIdMembersPost201Response._();

  factory ApiGovernanceCommitteesIdMembersPost201Response([void updates(ApiGovernanceCommitteesIdMembersPost201ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdMembersPost201Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdMembersPost201ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdMembersPost201Response> get serializer => _$ApiGovernanceCommitteesIdMembersPost201ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdMembersPost201ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdMembersPost201Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdMembersPost201Response, _$ApiGovernanceCommitteesIdMembersPost201Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdMembersPost201Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdMembersPost201Response object, {
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
      specifiedType: const FullType(ApiGovernanceCommitteesIdDelete207ResponseData),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdMembersPost201Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdMembersPost201ResponseBuilder result,
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
  ApiGovernanceCommitteesIdMembersPost201Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdMembersPost201ResponseBuilder();
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

