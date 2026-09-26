//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_post201_response_data.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_post201_response.g.dart';

/// ApiGovernanceCommitteesPost201Response
///
/// Properties:
/// * [success] 
/// * [data] 
@BuiltValue()
abstract class ApiGovernanceCommitteesPost201Response implements Built<ApiGovernanceCommitteesPost201Response, ApiGovernanceCommitteesPost201ResponseBuilder> {
  @BuiltValueField(wireName: r'success')
  bool get success;

  @BuiltValueField(wireName: r'data')
  ApiGovernanceCommitteesPost201ResponseData get data;

  ApiGovernanceCommitteesPost201Response._();

  factory ApiGovernanceCommitteesPost201Response([void updates(ApiGovernanceCommitteesPost201ResponseBuilder b)]) = _$ApiGovernanceCommitteesPost201Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesPost201ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesPost201Response> get serializer => _$ApiGovernanceCommitteesPost201ResponseSerializer();
}

class _$ApiGovernanceCommitteesPost201ResponseSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesPost201Response> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesPost201Response, _$ApiGovernanceCommitteesPost201Response];

  @override
  final String wireName = r'ApiGovernanceCommitteesPost201Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesPost201Response object, {
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
      specifiedType: const FullType(ApiGovernanceCommitteesPost201ResponseData),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesPost201Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesPost201ResponseBuilder result,
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
            specifiedType: const FullType(ApiGovernanceCommitteesPost201ResponseData),
          ) as ApiGovernanceCommitteesPost201ResponseData;
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
  ApiGovernanceCommitteesPost201Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesPost201ResponseBuilder();
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

