// packages/db/src/types.ts
// Shared TypeScript interfaces matching the actual PostgreSQL schema.
// Both gremion-ui and gremion-public import from here.

export interface Committee {
  id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  visibility: string;
  keycloak_group_id: string | null;
  created_at: Date;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: Date;
  end_at: Date;
  all_day: boolean;
  event_type_id: string | null;
  is_multi_committee: boolean;
  created_by: string;
  source: 'manual' | 'helios' | 'minutes' | 'holiday' | 'newsletter';
  external_id: string | null;
  caldav_uid: string | null;
  caldav_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  is_public: boolean;
}

export interface EventRecurrence {
  event_id: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  until: Date | null;
  count: number | null;
  byday: string[] | null;
  exceptions: Date[] | null;
}

export interface Protocol {
  id: string;
  committee_id: string;
  meeting_date: Date;
  location: string | null;
  title: string;
  body_html: string | null;
  nextcloud_draft_path: string | null;
  nextcloud_published_path: string | null;
  pdf_nextcloud_path: string | null;
  status: 'draft' | 'submitted' | 'published';
  guest_edit_enabled: boolean;
  approval_poll_id: string | null;
  revision_notes: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface ProtocolAttendance {
  id: string;
  protocol_id: string;
  user_keycloak_id: string;
  status: 'present' | 'absent' | 'excused';
}

export interface ProtocolResolution {
  id: string;
  protocol_id: string;
  sequence_nr: number;
  global_nr: string | null;
  text: string;
  // Nullable since migration 054: an 'acclamation' row may carry NO tally (all
  // three NULL); only a 'tally' row is guaranteed all three counts.
  votes_yes: number | null;
  votes_no: number | null;
  votes_abstain: number | null;
  result: 'passed' | 'rejected' | 'withdrawn';
  // 042/054: the decision rule fixed at creation — the full 5-rule core
  // vocabulary the DB CHECK permits.
  required_majority: 'simple' | 'two_thirds' | 'absolute' | 'consent' | 'support_threshold';
  // 054: how the binding decision is reached.
  adoption_mode: 'tally' | 'acclamation';
  // 054: parameters of a parametrised rule (support_threshold → { fraction });
  // NULL for the parameterless rules.
  decision_rule_params: Record<string, unknown> | null;
  // 048: when adoption was finalised (protocol publish); NULL for rows decided
  // before the column existed.
  decided_at: Date | null;
  created_at: Date;
}

export interface ProtocolActionItem {
  id: string;
  protocol_id: string;
  assignee_keycloak_id: string | null;
  text: string;
  due_date: Date | null;
  completed: boolean;
  created_at: Date;
}

export interface NewsPost {
  id: number;
  title: string;
  slug: string;
  body_html: string;
  author_id: string;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** L4: idempotency anchor for the content-service portal-publish callback. NULL for news posts not originating from the content engine. */
  content_origin_post_id: string | null;
}
