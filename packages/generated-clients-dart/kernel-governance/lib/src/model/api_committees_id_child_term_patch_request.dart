//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'api_committees_id_child_term_patch_request.g.dart';

/// ApiCommitteesIdChildTermPatchRequest
///
/// Properties:
/// * [childTerm] - '' clears the override: stored as NULL so the unit reverts to the tenant kind-catalog default child term (P2.2 #202)
@BuiltValue()
abstract class ApiCommitteesIdChildTermPatchRequest implements Built<ApiCommitteesIdChildTermPatchRequest, ApiCommitteesIdChildTermPatchRequestBuilder> {
  /// '' clears the override: stored as NULL so the unit reverts to the tenant kind-catalog default child term (P2.2 #202)
  @BuiltValueField(wireName: r'childTerm')
  String get childTerm;

  ApiCommitteesIdChildTermPatchRequest._();

  factory ApiCommitteesIdChildTermPatchRequest([void updates(ApiCommitteesIdChildTermPatchRequestBuilder b)]) = _$ApiCommitteesIdChildTermPatchRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ApiCommitteesIdChildTermPatchRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ApiCommitteesIdChildTermPatchRequest> get serializer => _$ApiCommitteesIdChildTermPatchRequestSerializer();
}

class _$ApiCommitteesIdChildTermPatchRequestSerializer implements PrimitiveSerializer<ApiCommitteesIdChildTermPatchRequest> {
  @override
  final Iterable<Type> types = const [ApiCommitteesIdChildTermPatchRequest, _$ApiCommitteesIdChildTermPatchRequest];

  @override
  final String wireName = r'ApiCommitteesIdChildTermPatchRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ApiCommitteesIdChildTermPatchRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'childTerm';
    yield serializers.serialize(
      object.childTerm,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    ApiCommitteesIdChildTermPatchRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ApiCommitteesIdChildTermPatchRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'childTerm':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.childTerm = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ApiCommitteesIdChildTermPatchRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ApiCommitteesIdChildTermPatchRequestBuilder();
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

