//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/org_unit.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_patch200_response.g.dart';

/// ApiGovernanceCommitteesIdPatch200Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdPatch200Response implements Built<ApiGovernanceCommitteesIdPatch200Response, ApiGovernanceCommitteesIdPatch200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  @BuiltValueField(wireName: r'data')
  OrgUnit get data;

  ApiGovernanceCommitteesIdPatch200Response._();

  factory ApiGovernanceCommitteesIdPatch200Response([void updates(ApiGovernanceCommitteesIdPatch200ResponseBuilder b)]) = _$ApiGovernanceCommitteesIdPatch200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdPatch200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdPatch200Response> get serializer => _$ApiGovernanceCommitteesIdPatch200ResponseSerializer();
}

class _$ApiGovernanceCommitteesIdPatch200ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdPatch200Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdPatch200Response, _$ApiGovernanceCommitteesIdPatch200Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdPatch200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdPatch200Response object, {
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
      specifiedType: const FullType(OrgUnit),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdPatch200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdPatch200ResponseBuilder result,
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
            specifiedType: const FullType(OrgUnit),
          ) as OrgUnit;
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
  ApiGovernanceCommitteesIdPatch200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdPatch200ResponseBuilder();
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

