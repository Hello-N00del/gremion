//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_kernel_governance_client/src/model/provisioning_report.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_groups_post201_response_data.g.dart';

/// ApiGroupsPost201ResponseData
///
/// Properties:
/// * [id] 
/// * [report] 
@BuiltValue()
abstract class ApiGroupsPost201ResponseData implements Built<ApiGroupsPost201ResponseData, ApiGroupsPost201ResponseDataBuilder> {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'report')
  ProvisioningReport get report;

  ApiGroupsPost201ResponseData._();

  factory ApiGroupsPost201ResponseData([void updates(ApiGroupsPost201ResponseDataBuilder b)]) = _$ApiGroupsPost201ResponseData;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGroupsPost201ResponseDataBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGroupsPost201ResponseData> get serializer => _$ApiGroupsPost201ResponseDataSerializer();
}

class _$ApiGroupsPost201ResponseDataSerializer implements PrimitiveSerializer<ApiGroupsPost201ResponseData> {
  @override
  final Iterable<Type> types = const [ApiGroupsPost201ResponseData, _$ApiGroupsPost201ResponseData];

  @override
  final String wireName = r'ApiGroupsPost201ResponseData';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGroupsPost201ResponseData object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'id';
    yield serializers.serialize(
      object.id,
      specifiedType: const FullType(String),
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
    ApiGroupsPost201ResponseData object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGroupsPost201ResponseDataBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.id = valueDes;
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
  ApiGroupsPost201ResponseData deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGroupsPost201ResponseDataBuilder();
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

