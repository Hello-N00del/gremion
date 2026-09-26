//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_governance_http_client/src/model/problem_admission_exists.dart';
import 'package:gremion_governance_http_client/src/model/problem_motion_not_late.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';
import 'package:one_of/one_of.dart';

part 'problem_motion_admission_conflict.g.dart';

/// Why an admission decision was refused: the motion is not late, or its admission is already decided (append-only, PRD-MTG-003).
///
/// Properties:
/// * [type] - The named refusal, as urn:gremion:problem:<slug> or urn:gremion:problem:gov:<slug>.
/// * [title] 
/// * [status] 
/// * [detail] 
/// * [instance] 
@BuiltValue()
abstract class ProblemMotionAdmissionConflict implements Built<ProblemMotionAdmissionConflict, ProblemMotionAdmissionConflictBuilder> {
  /// One Of [ProblemAdmissionExists], [ProblemMotionNotLate]
  OneOf get oneOf;

  ProblemMotionAdmissionConflict._();

  factory ProblemMotionAdmissionConflict([void updates(ProblemMotionAdmissionConflictBuilder b)]) = _$ProblemMotionAdmissionConflict;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ProblemMotionAdmissionConflictBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ProblemMotionAdmissionConflict> get serializer => _$ProblemMotionAdmissionConflictSerializer();
}

class _$ProblemMotionAdmissionConflictSerializer implements PrimitiveSerializer<ProblemMotionAdmissionConflict> {
  @override
  final Iterable<Type> types = const [ProblemMotionAdmissionConflict, _$ProblemMotionAdmissionConflict];

  @override
  final String wireName = r'ProblemMotionAdmissionConflict';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ProblemMotionAdmissionConflict object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
  }

  @override
  Object serialize(
    Serializers serializers,
    ProblemMotionAdmissionConflict object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final oneOf = object.oneOf;
    return serializers.serialize(oneOf.value, specifiedType: FullType(oneOf.valueType))!;
  }

  @override
  ProblemMotionAdmissionConflict deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ProblemMotionAdmissionConflictBuilder();
    Object? oneOfDataSrc;
    final targetType = const FullType(OneOf, [FullType(ProblemMotionNotLate), FullType(ProblemAdmissionExists), ]);
    oneOfDataSrc = serialized;
    result.oneOf = serializers.deserialize(oneOfDataSrc, specifiedType: targetType) as OneOf;
    return result.build();
  }
}

