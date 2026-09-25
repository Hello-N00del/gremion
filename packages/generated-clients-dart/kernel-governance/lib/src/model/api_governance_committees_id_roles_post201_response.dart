//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/committee_role.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_roles_post201_response.g.dart';

/// ApiGovernanceCommitteesIdRolesPost201Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdRolesPost201Response implements Built<ApiGovernanceCommitteesIdRolesPost201Response, ApiGovernanceCommitteesIdRolesPost201ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  JsonObject? get success;

  @BuiltValueField(wireName: r'data')
  CommitteeRole get data;

  ApiGovernanceCommitteesIdRolesPost201Response._();

  factory ApiGovernanceCommitteesIdRolesPost201Response([void updates(ApiGovernanceCommitteesIdRolesPost201ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdRolesPost201Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdRolesPost201ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdRolesPost201Response> get serializer => _$ApiGovernanceCommitteesIdRolesPost201ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdRolesPost201ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdRolesPost201Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdRolesPost201Response, _$ApiGovernanceCommitteesIdRolesPost201Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdRolesPost201Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesPost201Response object, {
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
      specifiedType: const FullType(CommitteeRole),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesPost201Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdRolesPost201ResponseBuilder result,
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
            specifiedType: const FullType(CommitteeRole),
          ) as CommitteeRole;
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
  ApiGovernanceCommitteesIdRolesPost201Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdRolesPost201ResponseBuilder();
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

