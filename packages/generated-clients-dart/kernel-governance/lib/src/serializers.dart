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
import 'package:gremion_kernel_governance_client/src/date_serializer.dart';
import 'package:gremion_kernel_governance_client/src/model/date.dart';

import 'package:gremion_kernel_governance_client/src/model/api_committees_id_child_term_patch200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_committees_id_child_term_patch_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_delete200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_delete207_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_delete207_response_data.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_history_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_members_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_members_post201_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_members_post_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_patch200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_patch_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_provision_post200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_roles_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_roles_post201_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_roles_post_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_roles_role_id_assign_post201_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_roles_role_id_assign_post_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_roles_role_id_revoke_post200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_id_roles_role_id_revoke_post_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_post201_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_post201_response_data.dart';
import 'package:gremion_kernel_governance_client/src/model/api_governance_committees_post_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_groups_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_groups_id_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_groups_id_patch_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_groups_post201_response.dart';
import 'package:gremion_kernel_governance_client/src/model/api_groups_post201_response_data.dart';
import 'package:gremion_kernel_governance_client/src/model/api_groups_post_request.dart';
import 'package:gremion_kernel_governance_client/src/model/api_health_get200_response.dart';
import 'package:gremion_kernel_governance_client/src/model/committee_member.dart';
import 'package:gremion_kernel_governance_client/src/model/committee_role.dart';
import 'package:gremion_kernel_governance_client/src/model/governance_error.dart';
import 'package:gremion_kernel_governance_client/src/model/governance_ok.dart';
import 'package:gremion_kernel_governance_client/src/model/org_unit.dart';
import 'package:gremion_kernel_governance_client/src/model/org_unit_member.dart';
import 'package:gremion_kernel_governance_client/src/model/provisioning_report.dart';
import 'package:gremion_kernel_governance_client/src/model/role_assignment.dart';
import 'package:gremion_kernel_governance_client/src/model/role_assignment_history_entry.dart';
import 'package:gremion_kernel_governance_client/src/model/subsystem_result.dart';
import 'package:gremion_kernel_governance_client/src/model/svelte_kit_http_error.dart';

part 'serializers.g.dart';

@SerializersFor([
  ApiCommitteesIdChildTermPatch200Response,
  ApiCommitteesIdChildTermPatchRequest,
  ApiGovernanceCommitteesGet200Response,
  ApiGovernanceCommitteesIdDelete200Response,
  ApiGovernanceCommitteesIdDelete207Response,
  ApiGovernanceCommitteesIdDelete207ResponseData,
  ApiGovernanceCommitteesIdGet200Response,
  ApiGovernanceCommitteesIdHistoryGet200Response,
  ApiGovernanceCommitteesIdMembersGet200Response,
  ApiGovernanceCommitteesIdMembersPost201Response,
  ApiGovernanceCommitteesIdMembersPostRequest,
  ApiGovernanceCommitteesIdPatch200Response,
  ApiGovernanceCommitteesIdPatchRequest,
  ApiGovernanceCommitteesIdProvisionPost200Response,
  ApiGovernanceCommitteesIdRolesGet200Response,
  ApiGovernanceCommitteesIdRolesPost201Response,
  ApiGovernanceCommitteesIdRolesPostRequest,
  ApiGovernanceCommitteesIdRolesRoleIdAssignPost201Response,
  ApiGovernanceCommitteesIdRolesRoleIdAssignPostRequest,
  ApiGovernanceCommitteesIdRolesRoleIdRevokePost200Response,
  ApiGovernanceCommitteesIdRolesRoleIdRevokePostRequest,
  ApiGovernanceCommitteesPost201Response,
  ApiGovernanceCommitteesPost201ResponseData,
  ApiGovernanceCommitteesPostRequest,
  ApiGroupsGet200Response,
  ApiGroupsIdGet200Response,
  ApiGroupsIdPatchRequest,
  ApiGroupsPost201Response,
  ApiGroupsPost201ResponseData,
  ApiGroupsPostRequest,
  ApiHealthGet200Response,
  CommitteeMember,
  CommitteeRole,
  GovernanceError,
  GovernanceOk,
  OrgUnit,
  OrgUnitMember,$OrgUnitMember,
  ProvisioningReport,
  RoleAssignment,
  RoleAssignmentHistoryEntry,
  SubsystemResult,
  SvelteKitHttpError,
])
Serializers serializers = (_$serializers.toBuilder()
      ..addBuilderFactory(
        const FullType(BuiltMap, [FullType(String), FullType.nullable(JsonObject)]),
        () => MapBuilder<String, JsonObject>(),
      )
      ..add(OrgUnitMember.serializer)
      ..add(const OneOfSerializer())
      ..add(const AnyOfSerializer())
      ..add(const DateSerializer())
      ..add(Iso8601DateTimeSerializer()))
    .build();

Serializers standardSerializers =
    (serializers.toBuilder()..addPlugin(StandardJsonPlugin())).build();
