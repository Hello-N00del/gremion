//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_get200_response.g.dart';

/// ApiGovernanceCommitteesIdGet200Response
///
/// Properties:
/// * [success] 
/// * [data] - OrgUnit fields spread with members (OrgUnitMember[]), roles (CommitteeRole[]), children (OrgUnit[]) — see getOrgUnit + listOrgUnitMembers + listRoles + getChildOrgUnits
@BuiltValue()
abstract class ApiGovernanceCommitteesIdGet200Response implements Built<ApiGovernanceCommitteesIdGet200Response, ApiGovernanceCommitteesIdGet200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  JsonObject? get success;

  /// OrgUnit fields spread with members (OrgUnitMember[]), roles (CommitteeRole[]), children (OrgUnit[]) — see getOrgUnit + listOrgUnitMembers + listRoles + getChildOrgUnits
  @BuiltValueField(wireName: r'data')
  BuiltMap<String, JsonObject?> get data;

  ApiGovernanceCommitteesIdGet200Response._();

  factory ApiGovernanceCommitteesIdGet200Response([void updates(ApiGovernanceCommitteesIdGet200ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdGet200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdGet200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdGet200Response> get serializer => _$ApiGovernanceCommitteesIdGet200ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdGet200ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdGet200Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdGet200Response, _$ApiGovernanceCommitteesIdGet200Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdGet200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdGet200Response object, {
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
    ApiGovernanceCommitteesIdGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdGet200ResponseBuilder result,
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
  ApiGovernanceCommitteesIdGet200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdGet200ResponseBuilder();
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

