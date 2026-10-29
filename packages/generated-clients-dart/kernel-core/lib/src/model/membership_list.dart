//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_kernel_core_client/src/model/date.dart';
import 'package:gremion_kernel_core_client/src/model/membership.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'membership_list.g.dart';

/// MembershipList
///
/// Properties:
/// * [bodyId] 
/// * [asOf] 
/// * [memberships] 
@BuiltValue()
abstract class MembershipList implements Built<MembershipList, MembershipListBuilder> {
  @BuiltValueField(wireName: r'bodyId')
  String get bodyId;

  @BuiltValueField(wireName: r'asOf')
  Date get asOf;

  @BuiltValueField(wireName: r'memberships')
  BuiltList<Membership> get memberships;

  MembershipList._();

  factory MembershipList([void updates(MembershipListBuilder b)]) = _$MembershipList;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MembershipListBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MembershipList> get serializer => _$MembershipListSerializer();
}

class _$MembershipListSerializer implements PrimitiveSerializer<MembershipList> {
  @override
  final Iterable<Type> types = const [MembershipList, _$MembershipList];

  @override
  final String wireName = r'MembershipList';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MembershipList object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'bodyId';
    yield serializers.serialize(
      object.bodyId,
      specifiedType: const FullType(String),
    );
    yield r'asOf';
    yield serializers.serialize(
      object.asOf,
      specifiedType: const FullType(Date),
    );
    yield r'memberships';
    yield serializers.serialize(
      object.memberships,
      specifiedType: const FullType(BuiltList, [FullType(Membership)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    MembershipList object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MembershipListBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'bodyId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.bodyId = valueDes;
          break;
        case r'asOf':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(Date),
          ) as Date;
          result.asOf = valueDes;
          break;
        case r'memberships':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(Membership)]),
          ) as BuiltList<Membership>;
          result.memberships.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  MembershipList deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MembershipListBuilder();
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

