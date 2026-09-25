//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_governance_client/src/model/subsystem_result.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'provisioning_report.g.dart';

/// Result of a provisioning or deprovisioning orchestration run — see provisioning/types.ts ProvisioningReport
///
/// Properties:
/// * [orgUnitId] 
/// * [overall] 
/// * [subsystems] 
@BuiltValue()
abstract class ProvisioningReport implements Built<ProvisioningReport, ProvisioningReportBuilder> {
  @BuiltValueField(wireName: r'orgUnitId')
  String get orgUnitId;

  @BuiltValueField(wireName: r'overall')
  ProvisioningReportOverallEnum get overall;
  // enum overallEnum {  ok,  degraded,  failed,  };

  @BuiltValueField(wireName: r'subsystems')
  BuiltList<SubsystemResult> get subsystems;

  ProvisioningReport._();

  factory ProvisioningReport([void updates(ProvisioningReportBuilder b)]) = _$ProvisioningReport;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ProvisioningReportBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ProvisioningReport> get serializer => _$ProvisioningReportSerializer();
}

class _$ProvisioningReportSerializer implements PrimitiveSerializer<ProvisioningReport> {
  @override
  final Iterable<Type> types = const [ProvisioningReport, _$ProvisioningReport];

  @override
  final String wireName = r'ProvisioningReport';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ProvisioningReport object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'orgUnitId';
    yield serializers.serialize(
      object.orgUnitId,
      specifiedType: const FullType(String),
    );
    yield r'overall';
    yield serializers.serialize(
      object.overall,
      specifiedType: const FullType(ProvisioningReportOverallEnum),
    );
    yield r'subsystems';
    yield serializers.serialize(
      object.subsystems,
      specifiedType: const FullType(BuiltList, [FullType(SubsystemResult)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ProvisioningReport object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ProvisioningReportBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'orgUnitId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.orgUnitId = valueDes;
          break;
        case r'overall':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ProvisioningReportOverallEnum),
          ) as ProvisioningReportOverallEnum;
          result.overall = valueDes;
          break;
        case r'subsystems':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(SubsystemResult)]),
          ) as BuiltList<SubsystemResult>;
          result.subsystems.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ProvisioningReport deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ProvisioningReportBuilder();
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

class ProvisioningReportOverallEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'ok')
  static const ProvisioningReportOverallEnum ok = _$provisioningReportOverallEnum_ok;
  @BuiltValueEnumConst(wireName: r'degraded')
  static const ProvisioningReportOverallEnum degraded = _$provisioningReportOverallEnum_degraded;
  @BuiltValueEnumConst(wireName: r'failed')
  static const ProvisioningReportOverallEnum failed = _$provisioningReportOverallEnum_failed;

  static Serializer<ProvisioningReportOverallEnum> get serializer => _$provisioningReportOverallEnumSerializer;

  const ProvisioningReportOverallEnum._(String name): super(name);

  static BuiltSet<ProvisioningReportOverallEnum> get values => _$provisioningReportOverallEnumValues;
  static ProvisioningReportOverallEnum valueOf(String name) => _$provisioningReportOverallEnumValueOf(name);
}

