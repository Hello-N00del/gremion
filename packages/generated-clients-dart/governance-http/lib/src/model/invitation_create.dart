//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'invitation_create.g.dart';

/// InvitationCreate
///
/// Properties:
/// * [note] - No required fields: an invitation draft is created from the meeting's current agenda snapshot server-side.
@BuiltValue()
abstract class InvitationCreate implements Built<InvitationCreate, InvitationCreateBuilder> {
  /// No required fields: an invitation draft is created from the meeting's current agenda snapshot server-side.
  @BuiltValueField(wireName: r'note')
  String? get note;

  InvitationCreate._();

  factory InvitationCreate([void updates(InvitationCreateBuilder b)]) = _$InvitationCreate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(InvitationCreateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<InvitationCreate> get serializer => _$InvitationCreateSerializer();
}

class _$InvitationCreateSerializer implements PrimitiveSerializer<InvitationCreate> {
  @override
  final Iterable<Type> types = const [InvitationCreate, _$InvitationCreate];

  @override
  final String wireName = r'InvitationCreate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    InvitationCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    if (object.note != null) {
      yield r'note';
      yield serializers.serialize(
        object.note,
        specifiedType: const FullType(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    InvitationCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required InvitationCreateBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'note':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.note = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  InvitationCreate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = InvitationCreateBuilder();
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

