//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/provisioning_report.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_delete207_response_data.g.dart';

/// ApiGovernanceCommitteesIdDelete207ResponseData
///
/// Properties:
/// * [report] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdDelete207ResponseData implements Built<ApiGovernanceCommitteesIdDelete207ResponseData, ApiGovernanceCommitteesIdDelete207ResponseDataBuilder> {
  @BuiltValueField(wireName: r'report')
  ProvisioningReport get report;

  ApiGovernanceCommitteesIdDelete207ResponseData._();

  factory ApiGovernanceCommitteesIdDelete207ResponseData([void updates(ApiGovernanceCommitteesIdDelete207ResponseDataBuilder b)]) = _$ApiGovernanceCommitteesIdDelete207ResponseData;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdDelete207ResponseDataBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdDelete207ResponseData> get serializer => _$ApiGovernanceCommitteesIdDelete207ResponseDataSerializer();
}

class _$ApiGovernanceCommitteesIdDelete207ResponseDataSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdDelete207ResponseData> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdDelete207ResponseData, _$ApiGovernanceCommitteesIdDelete207ResponseData];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdDelete207ResponseData';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdDelete207ResponseData object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'report';
    yield serializers.serialize(
      object.report,
      specifiedType: const FullType(ProvisioningReport),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdDelete207ResponseData object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdDelete207ResponseDataBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'report':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ProvisioningReport),
          ) as ProvisioningReport;
          result.report.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGovernanceCommitteesIdDelete207ResponseData deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdDelete207ResponseDataBuilder();
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

