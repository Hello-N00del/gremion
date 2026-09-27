//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'problem_agenda_frozen.g.dart';

/// Sections are added or reordered only by the chair and only before the invitation (DB-GOV-AGENDA-SECTION).
///
/// Properties:
/// * [type] - The named refusal, as urn:gremion:problem:<slug> or urn:gremion:problem:gov:<slug>.
/// * [title] 
/// * [status] 
/// * [detail] 
/// * [instance] 
@BuiltValue()
abstract class ProblemAgendaFrozen implements Built<ProblemAgendaFrozen, ProblemAgendaFrozenBuilder> {
  /// The named refusal, as urn:gremion:problem:<slug> or urn:gremion:problem:gov:<slug>.
  @BuiltValueField(wireName: r'type')
  String get type;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'status')
  int get status;

  @BuiltValueField(wireName: r'detail')
  String? get detail;

  @BuiltValueField(wireName: r'instance')
  String? get instance;

  ProblemAgendaFrozen._();

  factory ProblemAgendaFrozen([void updates(ProblemAgendaFrozenBuilder b)]) = _$ProblemAgendaFrozen;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ProblemAgendaFrozenBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ProblemAgendaFrozen> get serializer => _$ProblemAgendaFrozenSerializer();
}

class _$ProblemAgendaFrozenSerializer implements PrimitiveSerializer<ProblemAgendaFrozen> {
  @override
  final Iterable<Type> types = const [ProblemAgendaFrozen, _$ProblemAgendaFrozen];

  @override
  final String wireName = r'ProblemAgendaFrozen';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ProblemAgendaFrozen object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'type';
    yield serializers.serialize(
      object.type,
      specifiedType: const FullType(String),
    );
    yield r'title';
    yield serializers.serialize(
      object.title,
      specifiedType: const FullType(String),
    );
    yield r'status';
    yield serializers.serialize(
      object.status,
      specifiedType: const FullType(int),
    );
    if (object.detail != null) {
      yield r'detail';
      yield serializers.serialize(
        object.detail,
        specifiedType: const FullType(String),
      );
    }
    if (object.instance != null) {
      yield r'instance';
      yield serializers.serialize(
        object.instance,
        specifiedType: const FullType(String),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    ProblemAgendaFrozen object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ProblemAgendaFrozenBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'type':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.type = valueDes;
          break;
        case r'title':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.title = valueDes;
          break;
        case r'status':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.status = valueDes;
          break;
        case r'detail':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.detail = valueDes;
          break;
        case r'instance':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.instance = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  ProblemAgendaFrozen deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ProblemAgendaFrozenBuilder();
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

