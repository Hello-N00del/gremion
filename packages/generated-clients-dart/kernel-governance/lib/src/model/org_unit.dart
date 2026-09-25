//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'org_unit.g.dart';

/// OrgUnit
///
/// Properties:
/// * [id] 
/// * [parentId] 
/// * [kind] - Tenant org-unit-kind catalog key (FK org_unit_kind.key, migration 038; P2.2 #202) — per-tenant catalog, not a closed union. StuRa default catalog: council | committee | group.
/// * [name] 
/// * [description] 
/// * [childTerm] 
/// * [kindLabel] - Per-unit display-label override; null → tenant kind-catalog label (P2.2 #202, D-KL; migration 038)
/// * [authority] - beratend vs beschließend (P2.2 #202, §3.5(d)); NOT NULL DEFAULT 'deciding' (migration 038)
/// * [visibility] 
/// * [wantsMatrixRoom] 
/// * [wantsNextcloudFolder] 
/// * [createdAt] 
@BuiltValue()
abstract class OrgUnit implements Built<OrgUnit, OrgUnitBuilder> {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'parent_id')
  String? get parentId;

  /// Tenant org-unit-kind catalog key (FK org_unit_kind.key, migration 038; P2.2 #202) — per-tenant catalog, not a closed union. StuRa default catalog: council | committee | group.
  @BuiltValueField(wireName: r'kind')
  String get kind;

  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'description')
  String? get description;

  @BuiltValueField(wireName: r'child_term')
  String? get childTerm;

  /// Per-unit display-label override; null → tenant kind-catalog label (P2.2 #202, D-KL; migration 038)
  @BuiltValueField(wireName: r'kind_label')
  String? get kindLabel;

  /// beratend vs beschließend (P2.2 #202, §3.5(d)); NOT NULL DEFAULT 'deciding' (migration 038)
  @BuiltValueField(wireName: r'authority')
  OrgUnitAuthorityEnum get authority;
  // enum authorityEnum {  advisory,  deciding,  };

  @BuiltValueField(wireName: r'visibility')
  OrgUnitVisibilityEnum get visibility;
  // enum visibilityEnum {  all_members,  committee_only,  };

  @BuiltValueField(wireName: r'wants_matrix_room')
  bool get wantsMatrixRoom;

  @BuiltValueField(wireName: r'wants_nextcloud_folder')
  bool get wantsNextcloudFolder;

  @BuiltValueField(wireName: r'created_at')
  DateTime get createdAt;

  OrgUnit._();

  factory OrgUnit([void updates(OrgUnitBuilder b)]) = _$OrgUnit;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(OrgUnitBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<OrgUnit> get serializer => _$OrgUnitSerializer();
}

class _$OrgUnitSerializer implements PrimitiveSerializer<OrgUnit> {
  @override
  final Iterable<Type> types = const [OrgUnit, _$OrgUnit];

  @override
  final String wireName = r'OrgUnit';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    OrgUnit object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'id';
    yield serializers.serialize(
      object.id,
      specifiedType: const FullType(String),
    );
    if (object.parentId != null) {
      yield r'parent_id';
      yield serializers.serialize(
        object.parentId,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'kind';
    yield serializers.serialize(
      object.kind,
      specifiedType: const FullType(String),
    );
    yield r'name';
    yield serializers.serialize(
      object.name,
      specifiedType: const FullType(String),
    );
    if (object.description != null) {
      yield r'description';
      yield serializers.serialize(
        object.description,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.childTerm != null) {
      yield r'child_term';
      yield serializers.serialize(
        object.childTerm,
        specifiedType: const FullType.nullable(String),
      );
    }
    if (object.kindLabel != null) {
      yield r'kind_label';
      yield serializers.serialize(
        object.kindLabel,
        specifiedType: const FullType.nullable(String),
      );
    }
    yield r'authority';
    yield serializers.serialize(
      object.authority,
      specifiedType: const FullType(OrgUnitAuthorityEnum),
    );
    yield r'visibility';
    yield serializers.serialize(
      object.visibility,
      specifiedType: const FullType(OrgUnitVisibilityEnum),
    );
    yield r'wants_matrix_room';
    yield serializers.serialize(
      object.wantsMatrixRoom,
      specifiedType: const FullType(bool),
    );
    yield r'wants_nextcloud_folder';
    yield serializers.serialize(
      object.wantsNextcloudFolder,
      specifiedType: const FullType(bool),
    );
    yield r'created_at';
    yield serializers.serialize(
      object.createdAt,
      specifiedType: const FullType(DateTime),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    OrgUnit object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required OrgUnitBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.id = valueDes;
          break;
        case r'parent_id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.parentId = valueDes;
          break;
        case r'kind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.kind = valueDes;
          break;
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        case r'description':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.description = valueDes;
          break;
        case r'child_term':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.childTerm = valueDes;
          break;
        case r'kind_label':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(String),
          ) as String?;
          if (valueDes == null) continue;
          result.kindLabel = valueDes;
          break;
        case r'authority':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(OrgUnitAuthorityEnum),
          ) as OrgUnitAuthorityEnum;
          result.authority = valueDes;
          break;
        case r'visibility':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(OrgUnitVisibilityEnum),
          ) as OrgUnitVisibilityEnum;
          result.visibility = valueDes;
          break;
        case r'wants_matrix_room':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.wantsMatrixRoom = valueDes;
          break;
        case r'wants_nextcloud_folder':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.wantsNextcloudFolder = valueDes;
          break;
        case r'created_at':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(DateTime),
          ) as DateTime;
          result.createdAt = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  OrgUnit deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = OrgUnitBuilder();
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

class OrgUnitAuthorityEnum extends EnumClass {

  /// beratend vs beschließend (P2.2 #202, §3.5(d)); NOT NULL DEFAULT 'deciding' (migration 038)
  @BuiltValueEnumConst(wireName: r'advisory')
  static const OrgUnitAuthorityEnum advisory = _$orgUnitAuthorityEnum_advisory;
  /// beratend vs beschließend (P2.2 #202, §3.5(d)); NOT NULL DEFAULT 'deciding' (migration 038)
  @BuiltValueEnumConst(wireName: r'deciding')
  static const OrgUnitAuthorityEnum deciding = _$orgUnitAuthorityEnum_deciding;

  static Serializer<OrgUnitAuthorityEnum> get serializer => _$orgUnitAuthorityEnumSerializer;

  const OrgUnitAuthorityEnum._(String name): super(name);

  static BuiltSet<OrgUnitAuthorityEnum> get values => _$orgUnitAuthorityEnumValues;
  static OrgUnitAuthorityEnum valueOf(String name) => _$orgUnitAuthorityEnumValueOf(name);
}

class OrgUnitVisibilityEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'all_members')
  static const OrgUnitVisibilityEnum allMembers = _$orgUnitVisibilityEnum_allMembers;
  @BuiltValueEnumConst(wireName: r'committee_only')
  static const OrgUnitVisibilityEnum committeeOnly = _$orgUnitVisibilityEnum_committeeOnly;

  static Serializer<OrgUnitVisibilityEnum> get serializer => _$orgUnitVisibilityEnumSerializer;

  const OrgUnitVisibilityEnum._(String name): super(name);

  static BuiltSet<OrgUnitVisibilityEnum> get values => _$orgUnitVisibilityEnumValues;
  static OrgUnitVisibilityEnum valueOf(String name) => _$orgUnitVisibilityEnumValueOf(name);
}

