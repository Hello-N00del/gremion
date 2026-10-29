//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/grant.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'grant_list.g.dart';

/// GrantList
///
/// Properties:
/// * [grants] 
@BuiltValue()
abstract class GrantList implements Built<GrantList, GrantListBuilder> {
  @BuiltValueField(wireName: r'grants')
  BuiltList<Grant> get grants;

  GrantList._();

  factory GrantList([void updates(GrantListBuilder b)]) = _$GrantList;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(GrantListBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<GrantList> get serializer => _$GrantListSerializer();
}

class _$GrantListSerializer implements PrimitiveSerializer<GrantList> {
  @override
  final Iterable<Type> types = const [GrantList, _$GrantList];

  @override
  final String wireName = r'GrantList';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    GrantList object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'grants';
    yield serializers.serialize(
      object.grants,
      specifiedType: const FullType(BuiltList, [FullType(Grant)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    GrantList object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required GrantListBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'grants':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(Grant)]),
          ) as BuiltList<Grant>;
          result.grants.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  GrantList deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = GrantListBuilder();
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

