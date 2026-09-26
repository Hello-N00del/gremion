//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_import

import 'package:one_of_serializer/any_of_serializer.dart';
import 'package:one_of_serializer/one_of_serializer.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/serializer.dart';
import 'package:built_value/standard_json_plugin.dart';
import 'package:built_value/iso_8601_date_time_serializer.dart';
import 'package:gremion_governance_http_client/src/date_serializer.dart';
import 'package:gremion_governance_http_client/src/model/date.dart';

import 'package:gremion_governance_http_client/src/model/agenda_item.dart';
import 'package:gremion_governance_http_client/src/model/agenda_item_create.dart';
import 'package:gremion_governance_http_client/src/model/agenda_item_page.dart';
import 'package:gremion_governance_http_client/src/model/agenda_item_update.dart';
import 'package:gremion_governance_http_client/src/model/agenda_section.dart';
import 'package:gremion_governance_http_client/src/model/agenda_section_create.dart';
import 'package:gremion_governance_http_client/src/model/agenda_section_page.dart';
import 'package:gremion_governance_http_client/src/model/agenda_section_reorder.dart';
import 'package:gremion_governance_http_client/src/model/invitation.dart';
import 'package:gremion_governance_http_client/src/model/invitation_create.dart';
import 'package:gremion_governance_http_client/src/model/invitation_page.dart';
import 'package:gremion_governance_http_client/src/model/invitation_recipient.dart';
import 'package:gremion_governance_http_client/src/model/invitation_recipient_page.dart';
import 'package:gremion_governance_http_client/src/model/meeting.dart';
import 'package:gremion_governance_http_client/src/model/meeting_create.dart';
import 'package:gremion_governance_http_client/src/model/meeting_page.dart';
import 'package:gremion_governance_http_client/src/model/meeting_update.dart';
import 'package:gremion_governance_http_client/src/model/motion.dart';
import 'package:gremion_governance_http_client/src/model/motion_admission.dart';
import 'package:gremion_governance_http_client/src/model/motion_admission_create.dart';
import 'package:gremion_governance_http_client/src/model/motion_admission_page.dart';
import 'package:gremion_governance_http_client/src/model/motion_create.dart';
import 'package:gremion_governance_http_client/src/model/motion_page.dart';
import 'package:gremion_governance_http_client/src/model/notice_override.dart';
import 'package:gremion_governance_http_client/src/model/notice_override_create.dart';
import 'package:gremion_governance_http_client/src/model/problem.dart';
import 'package:gremion_governance_http_client/src/model/problem_admission_exists.dart';
import 'package:gremion_governance_http_client/src/model/problem_agenda_frozen.dart';
import 'package:gremion_governance_http_client/src/model/problem_forbidden.dart';
import 'package:gremion_governance_http_client/src/model/problem_invitation_already_dispatched.dart';
import 'package:gremion_governance_http_client/src/model/problem_motion_admission_conflict.dart';
import 'package:gremion_governance_http_client/src/model/problem_motion_not_late.dart';
import 'package:gremion_governance_http_client/src/model/problem_no_mail_connector.dart';
import 'package:gremion_governance_http_client/src/model/problem_not_found.dart';
import 'package:gremion_governance_http_client/src/model/problem_notice_override_conflict.dart';
import 'package:gremion_governance_http_client/src/model/problem_notice_override_missing.dart';
import 'package:gremion_governance_http_client/src/model/problem_override_exists.dart';
import 'package:gremion_governance_http_client/src/model/problem_override_not_required.dart';
import 'package:gremion_governance_http_client/src/model/problem_send_invitation_refused.dart';
import 'package:gremion_governance_http_client/src/model/problem_state_transition_refused.dart';
import 'package:gremion_governance_http_client/src/model/problem_unauthenticated.dart';
import 'package:gremion_governance_http_client/src/model/problem_validation_failed.dart';

part 'serializers.g.dart';

@SerializersFor([
  AgendaItem,
  AgendaItemCreate,
  AgendaItemPage,
  AgendaItemUpdate,
  AgendaSection,
  AgendaSectionCreate,
  AgendaSectionPage,
  AgendaSectionReorder,
  Invitation,
  InvitationCreate,
  InvitationPage,
  InvitationRecipient,
  InvitationRecipientPage,
  Meeting,
  MeetingCreate,
  MeetingPage,
  MeetingUpdate,
  Motion,
  MotionAdmission,
  MotionAdmissionCreate,
  MotionAdmissionPage,
  MotionCreate,
  MotionPage,
  NoticeOverride,
  NoticeOverrideCreate,
  Problem,
  ProblemAdmissionExists,
  ProblemAgendaFrozen,
  ProblemForbidden,
  ProblemInvitationAlreadyDispatched,
  ProblemMotionAdmissionConflict,
  ProblemMotionNotLate,
  ProblemNoMailConnector,
  ProblemNotFound,
  ProblemNoticeOverrideConflict,
  ProblemNoticeOverrideMissing,
  ProblemOverrideExists,
  ProblemOverrideNotRequired,
  ProblemSendInvitationRefused,
  ProblemStateTransitionRefused,
  ProblemUnauthenticated,
  ProblemValidationFailed,
])
Serializers serializers = (_$serializers.toBuilder()
      ..add(const OneOfSerializer())
      ..add(const AnyOfSerializer())
      ..add(const DateSerializer())
      ..add(Iso8601DateTimeSerializer()))
    .build();

Serializers standardSerializers =
    (serializers.toBuilder()..addPlugin(StandardJsonPlugin())).build();
