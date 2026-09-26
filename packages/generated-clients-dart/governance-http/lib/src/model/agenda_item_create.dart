//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'agenda_item_create.g.dart';

/// AgendaItemCreate
///
/// Properties:
/// * [sectionId] 
/// * [position] 
/// * [title] 
/// * [description] 
/// * [kind] 
/// * [ownPublicationClass] 
@BuiltValue()
abstract class AgendaItemCreate implements Built<AgendaItemCreate, AgendaItemCreateBuilder> {
  @BuiltValueField(wireName: r'section_id')
  String? get sectionId;

  @BuiltValueField(wireName: r'position')
  int? get position;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'description')
  String? get description;

  @BuiltValueField(wireName: r'kind')
  AgendaItemCreateKindEnum get kind;
  // enum kindEnum {  report,  motion,  previous_protocol_approval,  election,  misc,  };

  @BuiltValueField(wireName: r'own_publication_class')
  AgendaItemCreateOwnPublicationClassEnum? get ownPublicationClass;
  // enum ownPublicationClassEnum {  public,  non_public,  };

  AgendaItemCreate._();

  factory AgendaItemCreate([void updates(AgendaItemCreateBuilder b)]) = _$AgendaItemCreate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AgendaItemCreateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AgendaItemCreate> get serializer => _$AgendaItemCreateSerializer();
}

class _$AgendaItemCreateSerializer implements PrimitiveSerializer<AgendaItemCreate> {
  @override
  final Iterable<Type> types = const [AgendaItemCreate, _$AgendaItemCreate];

  @override
  final String wireName = r'AgendaItemCreate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AgendaItemCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    if (object.sectionId != null) {
      yield r'section_id';
      yield serializers.serialize(
        object.sectionId,
        specifiedType: const FullType(String),
      );
    }
    if (object.position != null) {
      yield r'position';
      yield serializers.serialize(
        object.position,
        specifiedType: const FullType(int),
      );
    }
    yield r'title';
    yield serializers.serialize(
      object.title,
      specifiedType: const FullType(String),
    );
    if (object.description != null) {
      yield r'description';
      yield serializers.serialize(
        object.description,
        specifiedType: const FullType(String),
      );
    }
    yield r'kind';
    yield serializers.serialize(
      object.kind,
      specifiedType: const FullType(AgendaItemCreateKindEnum),
    );
    if (object.ownPublicationClass != null) {
      yield r'own_publication_class';
      yield serializers.serialize(
        object.ownPublicationClass,
        specifiedType: const FullType(AgendaItemCreateOwnPublicationClassEnum),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    AgendaItemCreate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AgendaItemCreateBuilder result,
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
        case r'description':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.description = valueDes;
          break;
        case r'kind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(AgendaItemCreateKindEnum),
          ) as AgendaItemCreateKindEnum;
          result.kind = valueDes;
          break;
        case r'own_publication_class':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(AgendaItemCreateOwnPublicationClassEnum),
          ) as AgendaItemCreateOwnPublicationClassEnum;
          result.ownPublicationClass = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  AgendaItemCreate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AgendaItemCreateBuilder();
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

class AgendaItemCreateKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'report')
  static const AgendaItemCreateKindEnum report = _$agendaItemCreateKindEnum_report;
  @BuiltValueEnumConst(wireName: r'motion')
  static const AgendaItemCreateKindEnum motion = _$agendaItemCreateKindEnum_motion;
  @BuiltValueEnumConst(wireName: r'previous_protocol_approval')
  static const AgendaItemCreateKindEnum previousProtocolApproval = _$agendaItemCreateKindEnum_previousProtocolApproval;
  @BuiltValueEnumConst(wireName: r'election')
  static const AgendaItemCreateKindEnum election = _$agendaItemCreateKindEnum_election;
  @BuiltValueEnumConst(wireName: r'misc')
  static const AgendaItemCreateKindEnum misc = _$agendaItemCreateKindEnum_misc;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemCreateKindEnum unknownDefaultOpenApi = _$agendaItemCreateKindEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemCreateKindEnum> get serializer => _$agendaItemCreateKindEnumSerializer;

  const AgendaItemCreateKindEnum._(String name): super(name);

  static BuiltSet<AgendaItemCreateKindEnum> get values => _$agendaItemCreateKindEnumValues;
  static AgendaItemCreateKindEnum valueOf(String name) => _$agendaItemCreateKindEnumValueOf(name);
}

class AgendaItemCreateOwnPublicationClassEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'public')
  static const AgendaItemCreateOwnPublicationClassEnum public = _$agendaItemCreateOwnPublicationClassEnum_public;
  @BuiltValueEnumConst(wireName: r'non_public')
  static const AgendaItemCreateOwnPublicationClassEnum nonPublic = _$agendaItemCreateOwnPublicationClassEnum_nonPublic;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemCreateOwnPublicationClassEnum unknownDefaultOpenApi = _$agendaItemCreateOwnPublicationClassEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemCreateOwnPublicationClassEnum> get serializer => _$agendaItemCreateOwnPublicationClassEnumSerializer;

  const AgendaItemCreateOwnPublicationClassEnum._(String name): super(name);

  static BuiltSet<AgendaItemCreateOwnPublicationClassEnum> get values => _$agendaItemCreateOwnPublicationClassEnumValues;
  static AgendaItemCreateOwnPublicationClassEnum valueOf(String name) => _$agendaItemCreateOwnPublicationClassEnumValueOf(name);
}

