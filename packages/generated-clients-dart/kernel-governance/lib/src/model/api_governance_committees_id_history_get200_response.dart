//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_governance_client/src/model/role_assignment_history_entry.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_history_get200_response.g.dart';

/// ApiGovernanceCommitteesIdHistoryGet200Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdHistoryGet200Response implements Built<ApiGovernanceCommitteesIdHistoryGet200Response, ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  @BuiltValueField(wireName: r'data')
  BuiltList<RoleAssignmentHistoryEntry> get data;

  ApiGovernanceCommitteesIdHistoryGet200Response._();

  factory ApiGovernanceCommitteesIdHistoryGet200Response([void updates(ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdHistoryGet200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdHistoryGet200Response> get serializer => _$ApiGovernanceCommitteesIdHistoryGet200ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdHistoryGet200ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdHistoryGet200Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdHistoryGet200Response, _$ApiGovernanceCommitteesIdHistoryGet200Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdHistoryGet200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdHistoryGet200Response object, {
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
      specifiedType: const FullType(BuiltList, [FullType(RoleAssignmentHistoryEntry)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdHistoryGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder result,
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
            specifiedType: const FullType(BuiltList, [FullType(RoleAssignmentHistoryEntry)]),
          ) as BuiltList<RoleAssignmentHistoryEntry>;
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
  ApiGovernanceCommitteesIdHistoryGet200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdHistoryGet200ResponseBuilder();
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

