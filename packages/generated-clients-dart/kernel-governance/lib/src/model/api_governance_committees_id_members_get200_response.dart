//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_governance_client/src/model/committee_member.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_members_get200_response.g.dart';

/// ApiGovernanceCommitteesIdMembersGet200Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdMembersGet200Response implements Built<ApiGovernanceCommitteesIdMembersGet200Response, ApiGovernanceCommitteesIdMembersGet200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  JsonObject? get success;

  @BuiltValueField(wireName: r'data')
  BuiltList<CommitteeMember> get data;

  ApiGovernanceCommitteesIdMembersGet200Response._();

  factory ApiGovernanceCommitteesIdMembersGet200Response([void updates(ApiGovernanceCommitteesIdMembersGet200ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdMembersGet200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdMembersGet200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdMembersGet200Response> get serializer => _$ApiGovernanceCommitteesIdMembersGet200ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdMembersGet200ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdMembersGet200Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdMembersGet200Response, _$ApiGovernanceCommitteesIdMembersGet200Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdMembersGet200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdMembersGet200Response object, {
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
      specifiedType: const FullType(BuiltList, [FullType(CommitteeMember)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdMembersGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdMembersGet200ResponseBuilder result,
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
            specifiedType: const FullType(BuiltList, [FullType(CommitteeMember)]),
          ) as BuiltList<CommitteeMember>;
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
  ApiGovernanceCommitteesIdMembersGet200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdMembersGet200ResponseBuilder();
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

