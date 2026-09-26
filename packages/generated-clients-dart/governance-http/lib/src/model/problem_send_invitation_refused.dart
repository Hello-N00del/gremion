//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:gremion_governance_http_client/src/model/problem_notice_override_missing.dart';
import 'package:gremion_governance_http_client/src/model/problem_no_mail_connector.dart';
import 'package:gremion_governance_http_client/src/model/problem_state_transition_refused.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';
import 'package:one_of/one_of.dart';

part 'problem_send_invitation_refused.g.dart';

/// Why a dispatch was refused, by name: notice missed with no override recorded, no mail connector for the body (GOV never picks one), or the invitation is not in a sendable state (PRD-MTG-002a/002b).
///
/// Properties:
/// * [type] - The named refusal, as urn:gremion:problem:<slug> or urn:gremion:problem:gov:<slug>.
/// * [title] 
/// * [status] 
/// * [detail] 
/// * [instance] 
@BuiltValue()
abstract class ProblemSendInvitationRefused implements Built<ProblemSendInvitationRefused, ProblemSendInvitationRefusedBuilder> {
  /// One Of [ProblemNoMailConnector], [ProblemNoticeOverrideMissing], [ProblemStateTransitionRefused]
  OneOf get oneOf;

  ProblemSendInvitationRefused._();

  factory ProblemSendInvitationRefused([void updates(ProblemSendInvitationRefusedBuilder b)]) = _$ProblemSendInvitationRefused;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(ProblemSendInvitationRefusedBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<ProblemSendInvitationRefused> get serializer => _$ProblemSendInvitationRefusedSerializer();
}

class _$ProblemSendInvitationRefusedSerializer implements PrimitiveSerializer<ProblemSendInvitationRefused> {
  @override
  final Iterable<Type> types = const [ProblemSendInvitationRefused, _$ProblemSendInvitationRefused];

  @override
  final String wireName = r'ProblemSendInvitationRefused';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    ProblemSendInvitationRefused object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
  }

  @override
  Object serialize(
    Serializers serializers,
    ProblemSendInvitationRefused object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final oneOf = object.oneOf;
    return serializers.serialize(oneOf.value, specifiedType: FullType(oneOf.valueType))!;
  }

  @override
  ProblemSendInvitationRefused deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = ProblemSendInvitationRefusedBuilder();
    Object? oneOfDataSrc;
    final targetType = const FullType(OneOf, [FullType(ProblemNoticeOverrideMissing), FullType(ProblemNoMailConnector), FullType(ProblemStateTransitionRefused), ]);
    oneOfDataSrc = serialized;
    result.oneOf = serializers.deserialize(oneOfDataSrc, specifiedType: targetType) as OneOf;
    return result.build();
  }
}

