//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_governance_committees_id_roles_post_request.g.dart';

/// ApiGovernanceCommitteesIdRolesPostRequest
///
/// Properties:
/// * [name] 
/// * [electionMethod] 
/// * [isElected] 
/// * [gracePeriodDays] 
@BuiltValue()
abstract class ApiGovernanceCommitteesIdRolesPostRequest implements Built<ApiGovernanceCommitteesIdRolesPostRequest, ApiGovernanceCommitteesIdRolesPostRequestBuilder> {
  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'electionMethod')
  ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum? get electionMethod;
  // enum electionMethodEnum {  helios,  poll,  manual,  };

  @BuiltValueField(wireName: r'isElected')
  bool? get isElected;

  @BuiltValueField(wireName: r'gracePeriodDays')
  int? get gracePeriodDays;

  ApiGovernanceCommitteesIdRolesPostRequest._();

  factory ApiGovernanceCommitteesIdRolesPostRequest([void updates(ApiGovernanceCommitteesIdRolesPostRequestBuilder b)]) = _$ApiGovernanceCommitteesIdRolesPostRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiGovernanceCommitteesIdRolesPostRequestBuilder b) => b
      ..electionMethod = const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum._('manual')
      ..isElected = true
      ..gracePeriodDays = 14;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiGovernanceCommitteesIdRolesPostRequest> get serializer => _$ApiGovernanceCommitteesIdRolesPostRequestSerializer();
}

class _$ApiGovernanceCommitteesIdRolesPostRequestSerializer implements PrimitiveSerializer<ApiGovernanceCommitteesIdRolesPostRequest> {
  @override
  final Iterable<Type> types = const [ApiGovernanceCommitteesIdRolesPostRequest, _$ApiGovernanceCommitteesIdRolesPostRequest];

  @override
  final String wireName = r'ApiGovernanceCommitteesIdRolesPostRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'name';
    yield serializers.serialize(
      object.name,
      specifiedType: const FullType(String),
    );
    if (object.electionMethod != null) {
      yield r'electionMethod';
      yield serializers.serialize(
        object.electionMethod,
        specifiedType: const FullType(ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum),
      );
    }
    if (object.isElected != null) {
      yield r'isElected';
      yield serializers.serialize(
        object.isElected,
        specifiedType: const FullType(bool),
      );
    }
    if (object.gracePeriodDays != null) {
      yield r'gracePeriodDays';
      yield serializers.serialize(
        object.gracePeriodDays,
        specifiedType: const FullType(int),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiGovernanceCommitteesIdRolesPostRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiGovernanceCommitteesIdRolesPostRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        case r'electionMethod':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum),
          ) as ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum;
          result.electionMethod = valueDes;
          break;
        case r'isElected':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.isElected = valueDes;
          break;
        case r'gracePeriodDays':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.gracePeriodDays = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiGovernanceCommitteesIdRolesPostRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiGovernanceCommitteesIdRolesPostRequestBuilder();
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

class ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'helios')
  static const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum helios = _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_helios;
  @BuiltValueEnumConst(wireName: r'poll')
  static const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum poll = _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_poll;
  @BuiltValueEnumConst(wireName: r'manual')
  static const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum manual = _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_manual;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum unknownDefaultOpenApi = _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum_unknownDefaultOpenApi;

  static Serializer<ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum> get serializer => _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumSerializer;

  const ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum._(String name): super(name);

  static BuiltSet<ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum> get values => _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumValues;
  static ApiGovernanceCommitteesIdRolesPostRequestElectionMethodEnum valueOf(String name) => _$apiGovernanceCommitteesIdRolesPostRequestElectionMethodEnumValueOf(name);
}

