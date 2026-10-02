//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_roles_role_id_revoke_post_request.g.dart';

/// ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest
///
/// Properties:
/// * [reason] - Free-text recall reason; recorded verbatim in the 'mandate.revoked' audit payload. The route refuses more than 4000 characters (400).
@BuiltValue()
abstract class ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest implements Built<ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest, ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder> {
  /// Free-text recall reason; recorded verbatim in the 'mandate.revoked' audit payload. The route refuses more than 4000 characters (400).
  @BuiltValueField(wireName: r'reason')
  String get reason;

  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest._();

  factory ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest([void updates(ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder b)]) = _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest> get serializer => _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestSerializer();
}

class _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest, _$ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'reason';
    yield serializers.serialize(
      object.reason,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'reason':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.reason = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequestBuilder();
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

