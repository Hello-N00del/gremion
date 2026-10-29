//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'tenancy_self.g.dart';

/// TenancySelf
///
/// Properties:
/// * [customerId] - DB-TNT-CUSTOMER id: a canonical lower-case UUIDv7.
/// * [slug] 
/// * [realm] - DB-TNT-REALMREF: the customer's Keycloak realm.
@BuiltValue()
abstract class TenancySelf implements Built<TenancySelf, TenancySelfBuilder> {
  /// DB-TNT-CUSTOMER id: a canonical lower-case UUIDv7.
  @BuiltValueField(wireName: r'customerId')
  String get customerId;

  @BuiltValueField(wireName: r'slug')
  String get slug;

  /// DB-TNT-REALMREF: the customer's Keycloak realm.
  @BuiltValueField(wireName: r'realm')
  String get realm;

  TenancySelf._();

  factory TenancySelf([void updates(TenancySelfBuilder b)]) = _$TenancySelf;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(TenancySelfBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<TenancySelf> get serializer => _$TenancySelfSerializer();
}

class _$TenancySelfSerializer implements PrimitiveSerializer<TenancySelf> {
  @override
  final Iterable<Type> types = const [TenancySelf, _$TenancySelf];

  @override
  final String wireName = r'TenancySelf';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    TenancySelf object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'customerId';
    yield serializers.serialize(
      object.customerId,
      specifiedType: const FullType(String),
    );
    yield r'slug';
    yield serializers.serialize(
      object.slug,
      specifiedType: const FullType(String),
    );
    yield r'realm';
    yield serializers.serialize(
      object.realm,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    TenancySelf object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required TenancySelfBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'customerId':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.customerId = valueDes;
          break;
        case r'slug':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.slug = valueDes;
          break;
        case r'realm':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.realm = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  TenancySelf deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = TenancySelfBuilder();
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

