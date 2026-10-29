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
import 'package:gremion_kernel_core_client/src/date_serializer.dart';
import 'package:gremion_kernel_core_client/src/model/date.dart';

import 'package:gremion_kernel_core_client/src/model/authz_decision.dart';
import 'package:gremion_kernel_core_client/src/model/authz_decision_request.dart';
import 'package:gremion_kernel_core_client/src/model/authz_decision_request_resource.dart';
import 'package:gremion_kernel_core_client/src/model/body.dart';
import 'package:gremion_kernel_core_client/src/model/body_tree.dart';
import 'package:gremion_kernel_core_client/src/model/create_body.dart';
import 'package:gremion_kernel_core_client/src/model/customer_settings.dart';
import 'package:gremion_kernel_core_client/src/model/enabled_module.dart';
import 'package:gremion_kernel_core_client/src/model/enabled_modules.dart';
import 'package:gremion_kernel_core_client/src/model/grant.dart';
import 'package:gremion_kernel_core_client/src/model/grant_issue_request.dart';
import 'package:gremion_kernel_core_client/src/model/grant_list.dart';
import 'package:gremion_kernel_core_client/src/model/health.dart';
import 'package:gremion_kernel_core_client/src/model/invite_person.dart';
import 'package:gremion_kernel_core_client/src/model/membership.dart';
import 'package:gremion_kernel_core_client/src/model/membership_list.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime_database.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime_export.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime_platform_server.dart';
import 'package:gremion_kernel_core_client/src/model/module_runtime_timed_jobs_inner.dart';
import 'package:gremion_kernel_core_client/src/model/org_unit.dart';
import 'package:gremion_kernel_core_client/src/model/person.dart';
import 'package:gremion_kernel_core_client/src/model/preference.dart';
import 'package:gremion_kernel_core_client/src/model/preference_patch.dart';
import 'package:gremion_kernel_core_client/src/model/problem.dart';
import 'package:gremion_kernel_core_client/src/model/seat.dart';
import 'package:gremion_kernel_core_client/src/model/seat_holder.dart';
import 'package:gremion_kernel_core_client/src/model/seat_list.dart';
import 'package:gremion_kernel_core_client/src/model/seat_tenures.dart';
import 'package:gremion_kernel_core_client/src/model/start_membership.dart';
import 'package:gremion_kernel_core_client/src/model/tenancy_self.dart';
import 'package:gremion_kernel_core_client/src/model/tenure.dart';
import 'package:gremion_kernel_core_client/src/model/written.dart';

part 'serializers.g.dart';

@SerializersFor([
  AuthzDecision,
  AuthzDecisionRequest,
  AuthzDecisionRequestResource,
  Body,
  BodyTree,
  CreateBody,
  CustomerSettings,
  EnabledModule,
  EnabledModules,
  Grant,
  GrantIssueRequest,
  GrantList,
  Health,
  InvitePerson,
  Membership,
  MembershipList,
  ModuleRuntime,
  ModuleRuntimeDatabase,
  ModuleRuntimeExport,
  ModuleRuntimePlatformServer,
  ModuleRuntimeTimedJobsInner,
  OrgUnit,
  Person,
  Preference,
  PreferencePatch,
  Problem,
  Seat,
  SeatHolder,
  SeatList,
  SeatTenures,
  StartMembership,
  TenancySelf,
  Tenure,
  Written,
])
Serializers serializers = (_$serializers.toBuilder()
      ..add(const OneOfSerializer())
      ..add(const AnyOfSerializer())
      ..add(const DateSerializer())
      ..add(Iso8601DateTimeSerializer()))
    .build();

Serializers standardSerializers =
    (serializers.toBuilder()..addPlugin(StandardJsonPlugin())).build();
