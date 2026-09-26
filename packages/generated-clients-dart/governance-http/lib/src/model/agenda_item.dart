//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'agenda_item.g.dart';

/// AgendaItem
///
/// Properties:
/// * [agendaItemId] - DB-GOV-AGENDA-ITEM id (UUIDv7)
/// * [meetingId] - Owning meeting
/// * [sectionId] 
/// * [position] - Order within the section. Null while the item is proposed or declined; set together with section_id (SCHEMA agenda_item_placement_check).
/// * [itemNumber] - The printed TOP number; null until assigned.
/// * [title] 
/// * [description] 
/// * [kind] 
/// * [ownPublicationClass] 
/// * [state] - DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
/// * [proposerPersonId] 
/// * [outcome] - How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
@BuiltValue()
abstract class AgendaItem implements Built<AgendaItem, AgendaItemBuilder> {
  /// DB-GOV-AGENDA-ITEM id (UUIDv7)
  @BuiltValueField(wireName: r'agenda_item_id')
  String get agendaItemId;

  /// Owning meeting
  @BuiltValueField(wireName: r'meeting_id')
  String get meetingId;

  @BuiltValueField(wireName: r'section_id')
  String? get sectionId;

  /// Order within the section. Null while the item is proposed or declined; set together with section_id (SCHEMA agenda_item_placement_check).
  @BuiltValueField(wireName: r'position')
  int? get position;

  /// The printed TOP number; null until assigned.
  @BuiltValueField(wireName: r'item_number')
  String? get itemNumber;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'description')
  String? get description;

  @BuiltValueField(wireName: r'kind')
  AgendaItemKindEnum get kind;
  // enum kindEnum {  report,  motion,  previous_protocol_approval,  election,  misc,  };

  @BuiltValueField(wireName: r'own_publication_class')
  AgendaItemOwnPublicationClassEnum? get ownPublicationClass;
  // enum ownPublicationClassEnum {  public,  non_public,  };

  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueField(wireName: r'state')
  AgendaItemStateEnum get state;
  // enum stateEnum {  proposed,  placed,  declined,  withdrawn,  called,  dealt,  adjourned,  };

  @BuiltValueField(wireName: r'proposer_person_id')
  String? get proposerPersonId;

  /// How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
  @BuiltValueField(wireName: r'outcome')
  AgendaItemOutcomeEnum? get outcome;
  // enum outcomeEnum {  noted,  resolved,  rejected,  referred,  no_decision,  };

  AgendaItem._();

  factory AgendaItem([void updates(AgendaItemBuilder b)]) = _$AgendaItem;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(AgendaItemBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<AgendaItem> get serializer => _$AgendaItemSerializer();
}

class _$AgendaItemSerializer implements PrimitiveSerializer<AgendaItem> {
  @override
  final Iterable<Type> types = const [AgendaItem, _$AgendaItem];

  @override
  final String wireName = r'AgendaItem';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    AgendaItem object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'agenda_item_id';
    yield serializers.serialize(
      object.agendaItemId,
      specifiedType: const FullType(String),
    );
    yield r'meeting_id';
    yield serializers.serialize(
      object.meetingId,
      specifiedType: const FullType(String),
    );
    if (object.sectionId != null) {
      yield r'section_id';
      yield serializers.serialize(
        object.sectionId,
        specifiedType: const FullType(String),
      );
    }
    yield r'position';
    yield object.position == null ? null : serializers.serialize(
      object.position,
      specifiedType: const FullType.nullable(int),
    );
    if (object.itemNumber != null) {
      yield r'item_number';
      yield serializers.serialize(
        object.itemNumber,
        specifiedType: const FullType.nullable(String),
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
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'kind';
    yield serializers.serialize(
      object.kind,
      specifiedType: const FullType(AgendaItemKindEnum),
    );
    if (object.ownPublicationClass != null) {
      yield r'own_publication_class';
      yield serializers.serialize(
        object.ownPublicationClass,
        specifiedType: const FullType.nullable(AgendaItemOwnPublicationClassEnum),
      );
    }
    yield r'state';
    yield serializers.serialize(
      object.state,
      specifiedType: const FullType(AgendaItemStateEnum),
    );
    if (object.proposerPersonId != null) {
      yield r'proposer_person_id';
      yield serializers.serialize(
        object.proposerPersonId,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.outcome != null) {
      yield r'outcome';
      yield serializers.serialize(
        object.outcome,
        specifiedType: const FullType.nullable(AgendaItemOutcomeEnum),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    AgendaItem object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required AgendaItemBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'agenda_item_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.agendaItemId = valueDes;
          break;
        case r'meeting_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.meetingId = valueDes;
          break;
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
            specifiedType: const FullType.nullable(int),
          ) as int?;
          if (valueDes == null) continue;
          result.position = valueDes;
          break;
        case r'item_number':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.itemNumber = valueDes;
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
            specifiedType: const FullType(AgendaItemKindEnum),
          ) as AgendaItemKindEnum;
          result.kind = valueDes;
          break;
        case r'own_publication_class':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(AgendaItemOwnPublicationClassEnum),
          ) as AgendaItemOwnPublicationClassEnum?;
          if (valueDes == null) continue;
          result.ownPublicationClass = valueDes;
          break;
        case r'state':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(AgendaItemStateEnum),
          ) as AgendaItemStateEnum;
          result.state = valueDes;
          break;
        case r'proposer_person_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.proposerPersonId = valueDes;
          break;
        case r'outcome':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(AgendaItemOutcomeEnum),
          ) as AgendaItemOutcomeEnum?;
          if (valueDes == null) continue;
          result.outcome = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  AgendaItem deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = AgendaItemBuilder();
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

class AgendaItemKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'report')
  static const AgendaItemKindEnum report = _$agendaItemKindEnum_report;
  @BuiltValueEnumConst(wireName: r'motion')
  static const AgendaItemKindEnum motion = _$agendaItemKindEnum_motion;
  @BuiltValueEnumConst(wireName: r'previous_protocol_approval')
  static const AgendaItemKindEnum previousProtocolApproval = _$agendaItemKindEnum_previousProtocolApproval;
  @BuiltValueEnumConst(wireName: r'election')
  static const AgendaItemKindEnum election = _$agendaItemKindEnum_election;
  @BuiltValueEnumConst(wireName: r'misc')
  static const AgendaItemKindEnum misc = _$agendaItemKindEnum_misc;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemKindEnum unknownDefaultOpenApi = _$agendaItemKindEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemKindEnum> get serializer => _$agendaItemKindEnumSerializer;

  const AgendaItemKindEnum._(String name): super(name);

  static BuiltSet<AgendaItemKindEnum> get values => _$agendaItemKindEnumValues;
  static AgendaItemKindEnum valueOf(String name) => _$agendaItemKindEnumValueOf(name);
}

class AgendaItemOwnPublicationClassEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'public')
  static const AgendaItemOwnPublicationClassEnum public = _$agendaItemOwnPublicationClassEnum_public;
  @BuiltValueEnumConst(wireName: r'non_public')
  static const AgendaItemOwnPublicationClassEnum nonPublic = _$agendaItemOwnPublicationClassEnum_nonPublic;
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemOwnPublicationClassEnum unknownDefaultOpenApi = _$agendaItemOwnPublicationClassEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemOwnPublicationClassEnum> get serializer => _$agendaItemOwnPublicationClassEnumSerializer;

  const AgendaItemOwnPublicationClassEnum._(String name): super(name);

  static BuiltSet<AgendaItemOwnPublicationClassEnum> get values => _$agendaItemOwnPublicationClassEnumValues;
  static AgendaItemOwnPublicationClassEnum valueOf(String name) => _$agendaItemOwnPublicationClassEnumValueOf(name);
}

class AgendaItemStateEnum extends EnumClass {

  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'proposed')
  static const AgendaItemStateEnum proposed = _$agendaItemStateEnum_proposed;
  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'placed')
  static const AgendaItemStateEnum placed = _$agendaItemStateEnum_placed;
  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'declined')
  static const AgendaItemStateEnum declined = _$agendaItemStateEnum_declined;
  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'withdrawn')
  static const AgendaItemStateEnum withdrawn = _$agendaItemStateEnum_withdrawn;
  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'called')
  static const AgendaItemStateEnum called = _$agendaItemStateEnum_called;
  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'dealt')
  static const AgendaItemStateEnum dealt = _$agendaItemStateEnum_dealt;
  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'adjourned')
  static const AgendaItemStateEnum adjourned = _$agendaItemStateEnum_adjourned;
  /// DOMAIN Agenda item lifecycle (PRD-MTG-001/004).
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemStateEnum unknownDefaultOpenApi = _$agendaItemStateEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemStateEnum> get serializer => _$agendaItemStateEnumSerializer;

  const AgendaItemStateEnum._(String name): super(name);

  static BuiltSet<AgendaItemStateEnum> get values => _$agendaItemStateEnumValues;
  static AgendaItemStateEnum valueOf(String name) => _$agendaItemStateEnumValueOf(name);
}

class AgendaItemOutcomeEnum extends EnumClass {

  /// How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
  @BuiltValueEnumConst(wireName: r'noted')
  static const AgendaItemOutcomeEnum noted = _$agendaItemOutcomeEnum_noted;
  /// How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
  @BuiltValueEnumConst(wireName: r'resolved')
  static const AgendaItemOutcomeEnum resolved = _$agendaItemOutcomeEnum_resolved;
  /// How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
  @BuiltValueEnumConst(wireName: r'rejected')
  static const AgendaItemOutcomeEnum rejected = _$agendaItemOutcomeEnum_rejected;
  /// How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
  @BuiltValueEnumConst(wireName: r'referred')
  static const AgendaItemOutcomeEnum referred = _$agendaItemOutcomeEnum_referred;
  /// How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
  @BuiltValueEnumConst(wireName: r'no_decision')
  static const AgendaItemOutcomeEnum noDecision = _$agendaItemOutcomeEnum_noDecision;
  /// How the item was dealt with (DOMAIN DB-GOV-AGENDA-ITEM); set by the server exactly when state is dealt, null otherwise.
  @BuiltValueEnumConst(wireName: r'unknown_default_open_api', fallback: true)
  static const AgendaItemOutcomeEnum unknownDefaultOpenApi = _$agendaItemOutcomeEnum_unknownDefaultOpenApi;

  static Serializer<AgendaItemOutcomeEnum> get serializer => _$agendaItemOutcomeEnumSerializer;

  const AgendaItemOutcomeEnum._(String name): super(name);

  static BuiltSet<AgendaItemOutcomeEnum> get values => _$agendaItemOutcomeEnumValues;
  static AgendaItemOutcomeEnum valueOf(String name) => _$agendaItemOutcomeEnumValueOf(name);
}

