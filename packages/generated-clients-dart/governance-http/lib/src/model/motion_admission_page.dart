//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:gremion_governance_http_client/src/model/motion_admission.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'motion_admission_page.g.dart';

/// One page of MotionAdmission, in the list's stable server order.
///
/// Properties:
/// * [items] 
/// * [nextCursor] - Opaque cursor for the next page, or null at the end.
@BuiltValue()
abstract class MotionAdmissionPage implements Built<MotionAdmissionPage, MotionAdmissionPageBuilder> {
  @BuiltValueField(wireName: r'items')
  BuiltList<MotionAdmission> get items;

  /// Opaque cursor for the next page, or null at the end.
  @BuiltValueField(wireName: r'nextCursor')
  String? get nextCursor;

  MotionAdmissionPage._();

  factory MotionAdmissionPage([void updates(MotionAdmissionPageBuilder b)]) = _$MotionAdmissionPage;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(MotionAdmissionPageBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<MotionAdmissionPage> get serializer => _$MotionAdmissionPageSerializer();
}

class _$MotionAdmissionPageSerializer implements PrimitiveSerializer<MotionAdmissionPage> {
  @override
  final Iterable<Type> types = const [MotionAdmissionPage, _$MotionAdmissionPage];

  @override
  final String wireName = r'MotionAdmissionPage';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    MotionAdmissionPage object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'items';
    yield serializers.serialize(
      object.items,
      specifiedType: const FullType(BuiltList, [FullType(MotionAdmission)]),
    );
    yield r'nextCursor';
    yield object.nextCursor == null ? null : serializers.serialize(
      object.nextCursor,
      specifiedType: const FullType.nullable(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    MotionAdmissionPage object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required MotionAdmissionPageBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'items':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(MotionAdmission)]),
          ) as BuiltList<MotionAdmission>;
          result.items.replace(valueDes);
          break;
        case r'nextCursor':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.nextCursor = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  MotionAdmissionPage deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = MotionAdmissionPageBuilder();
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

