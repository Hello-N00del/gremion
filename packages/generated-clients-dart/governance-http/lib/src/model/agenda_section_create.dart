//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'agenda_section_create.g.dart';

/// AgendaSectionCreate
///
/// Properties:
/// * [position] 
/// * [title] 
/// * [publicationClass] 
@BuiltValue()
abstract class AgendaSectionCreate implements Built<AgendaSectionCreate, AgendaSectionCreateBuilder> {
  @BuiltValueField(wireName: r'position')
  int get position;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'publication_class')
  AgendaSectionCreatePublicationClassEnum get publicationClass;
  // enum publicationClassEnum {  public,  non_public,  };

  AgendaSectionCreate._();

  factory AgendaSectionCreate([void updates(AgendaSectionCreateBuilder b)]) = _$AgendaSectionCreate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AgendaSectionCreateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AgendaSectionCreate> get serializer => _$AgendaSectionCreateSerializer();
}

class _$AgendaSectionCreateSerializer implements PrimitiveSerializer<AgendaSectionCreate> {
  @override
  final Iterable<Type> types = const [AgendaSectionCreate, _$AgendaSectionCreate];

  @override
  final String wireName = r'AgendaSectionCreate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AgendaSectionCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'position';
    yield serializers.serialize(
      object.position,
      specifiedType: const FullType(int),
    );
    yield r'title';
    yield serializers.serialize(
      object.title,
      specifiedType: const FullType(String),
    );
    yield r'publication_class';
    yield serializers.serialize(
      object.publicationClass,
      specifiedType: const FullType(AgendaSectionCreatePublicationClassEnum),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    AgendaSectionCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AgendaSectionCreateBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'position':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.position = valueDes;
          break;
        case r'title':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.title = valueDes;
          break;
        case r'publication_class':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(AgendaSectionCreatePublicationClassEnum),
          ) as AgendaSectionCreatePublicationClassEnum;
          result.publicationClass = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  AgendaSectionCreate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AgendaSectionCreateBuilder();
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

class AgendaSectionCreatePublicationClassEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'public')
  static const AgendaSectionCreatePublicationClassEnum public = _$agendaSectionCreatePublicationClassEnum_public;
  @BuiltValueEnumConst(wireName: r'non_public')
  static const AgendaSectionCreatePublicationClassEnum nonPublic = _$agendaSectionCreatePublicationClassEnum_nonPublic;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaSectionCreatePublicationClassEnum unknownDefaultOpenApi = _$agendaSectionCreatePublicationClassEnum_unknownDefaultOpenApi;

  static Serializer<AgendaSectionCreatePublicationClassEnum> get serializer => _$agendaSectionCreatePublicationClassEnumSerializer;

  const AgendaSectionCreatePublicationClassEnum._(String name): super(name);

  static BuiltSet<AgendaSectionCreatePublicationClassEnum> get values => _$agendaSectionCreatePublicationClassEnumValues;
  static AgendaSectionCreatePublicationClassEnum valueOf(String name) => _$agendaSectionCreatePublicationClassEnumValueOf(name);
}

