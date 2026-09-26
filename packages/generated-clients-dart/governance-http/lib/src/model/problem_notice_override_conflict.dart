//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_governance_http_client/src/model/problem_invitation_already_dispatched.dart';
import 'package:gremion_governance_http_client/src/model/problem_override_not_required.dart';
import 'package:gremion_governance_http_client/src/model/problem_override_exists.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';
import 'package:one_of/one_of.dart';

part 'problem_notice_override_conflict.g.dart';

/// Why a notice override was refused: one already exists (append-only, at most one per invitation), notice was met so none is needed, or the invitation was already dispatched (PRD-MTG-002b).
///
/// Properties:
/// * [type] - The named refusal, as urn:gremion:problem:<slug> or urn:gremion:problem:gov:<slug>.
/// * [title] 
/// * [status] 
/// * [detail] 
/// * [instance] 
@BuiltValue()
abstract class ProblemNoticeOverrideConflict implements Built<ProblemNoticeOverrideConflict, ProblemNoticeOverrideConflictBuilder> {
  /// One Of [ProblemInvitationAlreadyDispatched], [ProblemOverrideExists], [ProblemOverrideNotRequired]
  OneOf get oneOf;

  ProblemNoticeOverrideConflict._();

  factory ProblemNoticeOverrideConflict([void updates(ProblemNoticeOverrideConflictBuilder b)]) = _$ProblemNoticeOverrideConflict;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ProblemNoticeOverrideConflictBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ProblemNoticeOverrideConflict> get serializer => _$ProblemNoticeOverrideConflictSerializer();
}

class _$ProblemNoticeOverrideConflictSerializer implements PrimitiveSerializer<ProblemNoticeOverrideConflict> {
  @override
  final Iterable<Type> types = const [ProblemNoticeOverrideConflict, _$ProblemNoticeOverrideConflict];

  @override
  final String wireName = r'ProblemNoticeOverrideConflict';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ProblemNoticeOverrideConflict object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
  }

  @override
  Object serialize(
    Serializers serializers,
    ProblemNoticeOverrideConflict object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final oneOf = object.oneOf;
    return serializers.serialize(oneOf.value, specifiedType: FullType(oneOf.valueType))!;
  }

  @override
  ProblemNoticeOverrideConflict deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ProblemNoticeOverrideConflictBuilder();
    Object? oneOfDataSrc;
    final targetType = const FullType(OneOf, [FullType(ProblemOverrideExists), FullType(ProblemOverrideNotRequired), FullType(ProblemInvitationAlreadyDispatched), ]);
    oneOfDataSrc = serialized;
    result.oneOf = serializers.deserialize(oneOfDataSrc, specifiedType: targetType) as OneOf;
    return result.build();
  }
}

