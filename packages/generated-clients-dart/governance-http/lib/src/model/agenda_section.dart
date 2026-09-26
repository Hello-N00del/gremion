//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'agenda_section.g.dart';

/// AgendaSection
///
/// Properties:
/// * [sectionId] - DB-GOV-AGENDA-SECTION id (bigint, carried as a string to avoid JS precision loss)
/// * [meetingId] - Owning meeting
/// * [position] 
/// * [title] 
/// * [publicationClass] 
@BuiltValue()
abstract class AgendaSection implements Built<AgendaSection, AgendaSectionBuilder> {
  /// DB-GOV-AGENDA-SECTION id (bigint, carried as a string to avoid JS precision loss)
  @BuiltValueField(wireName: r'section_id')
  String get sectionId;

  /// Owning meeting
  @BuiltValueField(wireName: r'meeting_id')
  String get meetingId;

  @BuiltValueField(wireName: r'position')
  int get position;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'publication_class')
  AgendaSectionPublicationClassEnum get publicationClass;
  // enum publicationClassEnum {  public,  non_public,  };

  AgendaSection._();

  factory AgendaSection([void updates(AgendaSectionBuilder b)]) = _$AgendaSection;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AgendaSectionBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AgendaSection> get serializer => _$AgendaSectionSerializer();
}

class _$AgendaSectionSerializer implements PrimitiveSerializer<AgendaSection> {
  @override
  final Iterable<Type> types = const [AgendaSection, _$AgendaSection];

  @override
  final String wireName = r'AgendaSection';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AgendaSection object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'section_id';
    yield serializers.serialize(
      object.sectionId,
      specifiedType: const FullType(String),
    );
    yield r'meeting_id';
    yield serializers.serialize(
      object.meetingId,
      specifiedType: const FullType(String),
    );
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
      specifiedType: const FullType(AgendaSectionPublicationClassEnum),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    AgendaSection object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AgendaSectionBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'section_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.sectionId = valueDes;
          break;
        case r'meeting_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.meetingId = valueDes;
          break;
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
            specifiedType: const FullType(AgendaSectionPublicationClassEnum),
          ) as AgendaSectionPublicationClassEnum;
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
  AgendaSection deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AgendaSectionBuilder();
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

class AgendaSectionPublicationClassEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'public')
  static const AgendaSectionPublicationClassEnum public = _$agendaSectionPublicationClassEnum_public;
  @BuiltValueEnumConst(wireName: r'non_public')
  static const AgendaSectionPublicationClassEnum nonPublic = _$agendaSectionPublicationClassEnum_nonPublic;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaSectionPublicationClassEnum unknownDefaultOpenApi = _$agendaSectionPublicationClassEnum_unknownDefaultOpenApi;

  static Serializer<AgendaSectionPublicationClassEnum> get serializer => _$agendaSectionPublicationClassEnumSerializer;

  const AgendaSectionPublicationClassEnum._(String name): super(name);

  static BuiltSet<AgendaSectionPublicationClassEnum> get values => _$agendaSectionPublicationClassEnumValues;
  static AgendaSectionPublicationClassEnum valueOf(String name) => _$agendaSectionPublicationClassEnumValueOf(name);
}

