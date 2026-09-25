//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_governance_client/src/model/org_unit.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_get200_response.g.dart';

/// ApiGovernanceCommitteesGet200Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesGet200Response implements Built<ApiGovernanceCommitteesGet200Response, ApiGovernanceCommitteesGet200ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  @BuiltValueField(wireName: r'data')
  BuiltList<OrgUnit> get data;

  ApiGovernanceCommitteesGet200Response._();

  factory ApiGovernanceCommitteesGet200Response([void updates(ApiGovernanceCommitteesGet200ResponseBuilder b)]) = _$ApiGovernanceCommitteesGet200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesGet200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesGet200Response> get serializer => _$ApiGovernanceCommitteesGet200ResponseSerializer();
}

class _$ApiGovernanceCommitteesGet200ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesGet200Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesGet200Response, _$ApiGovernanceCommitteesGet200Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesGet200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesGet200Response object, {
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
      specifiedType: const FullType(BuiltList, [FullType(OrgUnit)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesGet200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesGet200ResponseBuilder result,
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
            specifiedType: const FullType(BuiltList, [FullType(OrgUnit)]),
          ) as BuiltList<OrgUnit>;
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
  ApiGovernanceCommitteesGet200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesGet200ResponseBuilder();
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

