//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'svelte_kit_http_error.g.dart';

/// SvelteKit HttpError body produced by throw error(status, message) — shape {message:string}, NOT the GovernanceError envelope
///
/// Properties:
/// * [message] 
@BuiltValue()
abstract class SvelteKitHttpError implements Built<SvelteKitHttpError, SvelteKitHttpErrorBuilder> {
  @BuiltValueField(wireName: r'message')
  String get message;

  SvelteKitHttpError._();

  factory SvelteKitHttpError([void updates(SvelteKitHttpErrorBuilder b)]) = _$SvelteKitHttpError;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(SvelteKitHttpErrorBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<SvelteKitHttpError> get serializer => _$SvelteKitHttpErrorSerializer();
}

class _$SvelteKitHttpErrorSerializer implements PrimitiveSerializer<SvelteKitHttpError> {
  @override
  final Iterable<Type> types = const [SvelteKitHttpError, _$SvelteKitHttpError];

  @override
  final String wireName = r'SvelteKitHttpError';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    SvelteKitHttpError object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'message';
    yield serializers.serialize(
      object.message,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    SvelteKitHttpError object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required SvelteKitHttpErrorBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'message':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.message = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  SvelteKitHttpError deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = SvelteKitHttpErrorBuilder();
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

