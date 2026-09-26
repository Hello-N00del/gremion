//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/org_unit.dart';
import 'package:gremion_kernel_governance_client/src/model/provisioning_report.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_post201_response_data.g.dart';

/// ApiGovernanceCommitteesPost201ResponseData
///
/// Properties:
/// * [unit] 
/// * [report] 
@BuiltValue()
abstract class ApiGovernanceCommitteesPost201ResponseData implements Built<ApiGovernanceCommitteesPost201ResponseData, ApiGovernanceCommitteesPost201ResponseDataBuilder> {
  @BuiltValueField(wireName: r'unit')
  OrgUnit get unit;

  @BuiltValueField(wireName: r'report')
  ProvisioningReport get report;

  ApiGovernanceCommitteesPost201ResponseData._();

  factory ApiGovernanceCommitteesPost201ResponseData([void updates(ApiGovernanceCommitteesPost201ResponseDataBuilder b)]) = _$ApiGovernanceCommitteesPost201ResponseData;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesPost201ResponseDataBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesPost201ResponseData> get serializer => _$ApiGovernanceCommitteesPost201ResponseDataSerializer();
}

class _$ApiGovernanceCommitteesPost201ResponseDataSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesPost201ResponseData> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesPost201ResponseData, _$ApiGovernanceCommitteesPost201ResponseData];

  @override
  final String wireName = r'ApiGovernanceCommitteesPost201ResponseData';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesPost201ResponseData object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'unit';
    yield serializers.serialize(
      object.unit,
      specifiedType: const FullType(OrgUnit),
    );
    yield r'report';
    yield serializers.serialize(
      object.report,
      specifiedType: const FullType(ProvisioningReport),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesPost201ResponseData object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesPost201ResponseDataBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'unit':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(OrgUnit),
          ) as OrgUnit;
          result.unit.replace(valueDes);
          break;
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
  ApiGovernanceCommitteesPost201ResponseData deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesPost201ResponseDataBuilder();
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

