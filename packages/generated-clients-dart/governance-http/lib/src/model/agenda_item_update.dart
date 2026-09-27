//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'agenda_item_update.g.dart';

/// Partial update of an agenda item: send only the fields that change. state and outcome move only by the agenda-item lifecycle and are never written here (DOMAIN DB-GOV-AGENDA-ITEM).
///
/// Properties:
/// * [sectionId] 
/// * [position] 
/// * [title] 
/// * [description] - Send null to clear the description (SCHEMA gov.agenda_item.description nullable).
/// * [kind] 
/// * [ownPublicationClass] - Send null to fall back to the section's class (SCHEMA gov.agenda_item.own_publication_class nullable).
@BuiltValue()
abstract class AgendaItemUpdate implements Built<AgendaItemUpdate, AgendaItemUpdateBuilder> {
  @BuiltValueField(wireName: r'section_id')
  String? get sectionId;

  @BuiltValueField(wireName: r'position')
  int? get position;

  @BuiltValueField(wireName: r'title')
  String? get title;

  /// Send null to clear the description (SCHEMA gov.agenda_item.description nullable).
  @BuiltValueField(wireName: r'description')
  String? get description;

  @BuiltValueField(wireName: r'kind')
  AgendaItemUpdateKindEnum? get kind;
  // enum kindEnum {  report,  motion,  previous_protocol_approval,  election,  misc,  };

  /// Send null to fall back to the section's class (SCHEMA gov.agenda_item.own_publication_class nullable).
  @BuiltValueField(wireName: r'own_publication_class')
  AgendaItemUpdateOwnPublicationClassEnum? get ownPublicationClass;
  // enum ownPublicationClassEnum {  public,  non_public,  };

  AgendaItemUpdate._();

  factory AgendaItemUpdate([void updates(AgendaItemUpdateBuilder b)]) = _$AgendaItemUpdate;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AgendaItemUpdateBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AgendaItemUpdate> get serializer => _$AgendaItemUpdateSerializer();
}

class _$AgendaItemUpdateSerializer implements PrimitiveSerializer<AgendaItemUpdate> {
  @override
  final Iterable<Type> types = const [AgendaItemUpdate, _$AgendaItemUpdate];

  @override
  final String wireName = r'AgendaItemUpdate';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AgendaItemUpdate object, {
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
    if (object.title != null) {
      yield r'title';
      yield serializers.serialize(
        object.title,
        specifiedType: const FullType(String),
      );
    }
    if (object.description != null) {
      yield r'description';
      yield serializers.serialize(
        object.description,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.kind != null) {
      yield r'kind';
      yield serializers.serialize(
        object.kind,
        specifiedType: const FullType(AgendaItemUpdateKindEnum),
      );
    }
    if (object.ownPublicationClass != null) {
      yield r'own_publication_class';
      yield serializers.serialize(
        object.ownPublicationClass,
        specifiedType: const FullType.nullable(AgendaItemUpdateOwnPublicationClassEnum),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    AgendaItemUpdate object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AgendaItemUpdateBuilder result,
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
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.description = valueDes;
          break;
        case r'kind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(AgendaItemUpdateKindEnum),
          ) as AgendaItemUpdateKindEnum;
          result.kind = valueDes;
          break;
        case r'own_publication_class':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(AgendaItemUpdateOwnPublicationClassEnum),
          ) as AgendaItemUpdateOwnPublicationClassEnum?;
          if (valueDes == null) continue;
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
  AgendaItemUpdate deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AgendaItemUpdateBuilder();
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

class AgendaItemUpdateKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'report')
  static const AgendaItemUpdateKindEnum report = _$agendaItemUpdateKindEnum_report;
  @BuiltValueEnumConst(wireName: r'motion')
  static const AgendaItemUpdateKindEnum motion = _$agendaItemUpdateKindEnum_motion;
  @BuiltValueEnumConst(wireName: r'previous_protocol_approval')
  static const AgendaItemUpdateKindEnum previousProtocolApproval = _$agendaItemUpdateKindEnum_previousProtocolApproval;
  @BuiltValueEnumConst(wireName: r'election')
  static const AgendaItemUpdateKindEnum election = _$agendaItemUpdateKindEnum_election;
  @BuiltValueEnumConst(wireName: r'misc')
  static const AgendaItemUpdateKindEnum misc = _$agendaItemUpdateKindEnum_misc;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemUpdateKindEnum unknownDefaultOpenApi = _$agendaItemUpdateKindEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemUpdateKindEnum> get serializer => _$agendaItemUpdateKindEnumSerializer;

  const AgendaItemUpdateKindEnum._(String name): super(name);

  static BuiltSet<AgendaItemUpdateKindEnum> get values => _$agendaItemUpdateKindEnumValues;
  static AgendaItemUpdateKindEnum valueOf(String name) => _$agendaItemUpdateKindEnumValueOf(name);
}

class AgendaItemUpdateOwnPublicationClassEnum extends EnumClass {

  /// Send null to fall back to the section's class (SCHEMA gov.agenda_item.own_publication_class nullable).
  @BuiltValueEnumConst(wireName: r'public')
  static const AgendaItemUpdateOwnPublicationClassEnum public = _$agendaItemUpdateOwnPublicationClassEnum_public;
  /// Send null to fall back to the section's class (SCHEMA gov.agenda_item.own_publication_class nullable).
  @BuiltValueEnumConst(wireName: r'non_public')
  static const AgendaItemUpdateOwnPublicationClassEnum nonPublic = _$agendaItemUpdateOwnPublicationClassEnum_nonPublic;
  /// Send null to fall back to the section's class (SCHEMA gov.agenda_item.own_publication_class nullable).
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemUpdateOwnPublicationClassEnum unknownDefaultOpenApi = _$agendaItemUpdateOwnPublicationClassEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemUpdateOwnPublicationClassEnum> get serializer => _$agendaItemUpdateOwnPublicationClassEnumSerializer;

  const AgendaItemUpdateOwnPublicationClassEnum._(String name): super(name);

  static BuiltSet<AgendaItemUpdateOwnPublicationClassEnum> get values => _$agendaItemUpdateOwnPublicationClassEnumValues;
  static AgendaItemUpdateOwnPublicationClassEnum valueOf(String name) => _$agendaItemUpdateOwnPublicationClassEnumValueOf(name);
}

