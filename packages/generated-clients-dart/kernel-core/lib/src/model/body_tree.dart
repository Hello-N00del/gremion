//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/org_unit.dart';
import 'package:gremion_kernel_core_client/src/model/body.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'body_tree.g.dart';

/// Every body and org unit of the customer; the client builds the tree from parentBodyId / parentOrgUnitId.
///
/// Properties:
/// * [bodies] 
/// * [orgUnits] 
@BuiltValue()
abstract class BodyTree implements Built<BodyTree, BodyTreeBuilder> {
  @BuiltValueField(wireName: r'bodies')
  BuiltList<Body> get bodies;

  @BuiltValueField(wireName: r'orgUnits')
  BuiltList<OrgUnit> get orgUnits;

  BodyTree._();

  factory BodyTree([void updates(BodyTreeBuilder b)]) = _$BodyTree;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(BodyTreeBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<BodyTree> get serializer => _$BodyTreeSerializer();
}

class _$BodyTreeSerializer implements PrimitiveSerializer<BodyTree> {
  @override
  final Iterable<Type> types = const [BodyTree, _$BodyTree];

  @override
  final String wireName = r'BodyTree';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    BodyTree object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'bodies';
    yield serializers.serialize(
      object.bodies,
      specifiedType: const FullType(BuiltList, [FullType(Body)]),
    );
    yield r'orgUnits';
    yield serializers.serialize(
      object.orgUnits,
      specifiedType: const FullType(BuiltList, [FullType(OrgUnit)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    BodyTree object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required BodyTreeBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'bodies':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(Body)]),
          ) as BuiltList<Body>;
          result.bodies.replace(valueDes);
          break;
        case r'orgUnits':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(OrgUnit)]),
          ) as BuiltList<OrgUnit>;
          result.orgUnits.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  BodyTree deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = BodyTreeBuilder();
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

