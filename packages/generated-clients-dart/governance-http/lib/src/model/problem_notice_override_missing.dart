//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'problem_notice_override_missing.g.dart';

/// notice_met is false and no notice-override is recorded for this invitation; record one first (PRD-MTG-002b, DB-GOV-INVITATION). The Sitzung itself is never blocked [D R20-D26-5].
///
/// Properties:
/// * [type] - The named refusal, as urn:gremion:problem:<slug> or urn:gremion:problem:gov:<slug>.
/// * [title] 
/// * [status] 
/// * [detail] 
/// * [instance] 
@BuiltValue()
abstract class ProblemNoticeOverrideMissing implements Built<ProblemNoticeOverrideMissing, ProblemNoticeOverrideMissingBuilder> {
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

  ProblemNoticeOverrideMissing._();

  factory ProblemNoticeOverrideMissing([void updates(ProblemNoticeOverrideMissingBuilder b)]) = _$ProblemNoticeOverrideMissing;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ProblemNoticeOverrideMissingBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ProblemNoticeOverrideMissing> get serializer => _$ProblemNoticeOverrideMissingSerializer();
}

class _$ProblemNoticeOverrideMissingSerializer implements PrimitiveSerializer<ProblemNoticeOverrideMissing> {
  @override
  final Iterable<Type> types = const [ProblemNoticeOverrideMissing, _$ProblemNoticeOverrideMissing];

  @override
  final String wireName = r'ProblemNoticeOverrideMissing';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ProblemNoticeOverrideMissing object, {
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
    ProblemNoticeOverrideMissing object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required ProblemNoticeOverrideMissingBuilder result,
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
  ProblemNoticeOverrideMissing deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ProblemNoticeOverrideMissingBuilder();
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

