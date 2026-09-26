//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_governance_http_client/src/model/agenda_section.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'agenda_section_page.g.dart';

/// One page of AgendaSection, in the list's stable server order.
///
/// Properties:
/// * [items] 
/// * [nextCursor] - Opaque cursor for the next page, or null at the end.
@BuiltValue()
abstract class AgendaSectionPage implements Built<AgendaSectionPage, AgendaSectionPageBuilder> {
  @BuiltValueField(wireName: r'items')
  BuiltList<AgendaSection> get items;

  /// Opaque cursor for the next page, or null at the end.
  @BuiltValueField(wireName: r'nextCursor')
  String? get nextCursor;

  AgendaSectionPage._();

  factory AgendaSectionPage([void updates(AgendaSectionPageBuilder b)]) = _$AgendaSectionPage;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AgendaSectionPageBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AgendaSectionPage> get serializer => _$AgendaSectionPageSerializer();
}

class _$AgendaSectionPageSerializer implements PrimitiveSerializer<AgendaSectionPage> {
  @override
  final Iterable<Type> types = const [AgendaSectionPage, _$AgendaSectionPage];

  @override
  final String wireName = r'AgendaSectionPage';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AgendaSectionPage object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'items';
    yield serializers.serialize(
      object.items,
      specifiedType: const FullType(BuiltList, [FullType(AgendaSection)]),
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
    AgendaSectionPage object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AgendaSectionPageBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'items':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(AgendaSection)]),
          ) as BuiltList<AgendaSection>;
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
  AgendaSectionPage deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AgendaSectionPageBuilder();
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

