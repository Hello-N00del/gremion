//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/provisioning_report.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_provision_post200_response.g.dart';

/// ApiGovernanceCommitteesIdProvisionPost200Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdProvisionPost200Response implements Built<ApiGovernanceCommitteesIdProvisionPost200Response, ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  @BuiltValueField(wireName: r'data')
  ProvisioningReport get data;

  ApiGovernanceCommitteesIdProvisionPost200Response._();

  factory ApiGovernanceCommitteesIdProvisionPost200Response([void updates(ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdProvisionPost200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdProvisionPost200Response> get serializer => _$ApiGovernanceCommitteesIdProvisionPost200ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdProvisionPost200ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdProvisionPost200Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdProvisionPost200Response, _$ApiGovernanceCommitteesIdProvisionPost200Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdProvisionPost200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdProvisionPost200Response object, {
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
      specifiedType: const FullType(ProvisioningReport),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdProvisionPost200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder result,
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
            specifiedType: const FullType(ProvisioningReport),
          ) as ProvisioningReport;
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
  ApiGovernanceCommitteesIdProvisionPost200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdProvisionPost200ResponseBuilder();
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

