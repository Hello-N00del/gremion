// GDPR-safe projected types for the PUBLIC PORTAL app.
// Named by role, not by directory: this package is consumed from more than one repo and the
// portal's directory name differs between them; here it is gremion-public. The portal MUST
// import from '@gremion/db/public-types' — never from
// '@gremion/db' directly.
// EventRecurrence has no internal fields and is exported as-is.
// Committee and CalendarEvent use narrowed projections to exclude internal IAM identifiers
// and personal data that must not cross the public (unauthenticated) boundary.

export type { EventRecurrence } from './types.js';

// Narrowed public projection of Committee.
// Omits: keycloak_group_id (internal IAM identifier — exposes Keycloak group topology),
//        visibility (the all_members/committee_only tier — only all_members rows are
//        ever projected to the public, so the tier itself must not cross the boundary; #250).
export interface PublicCommittee {
  id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  created_at: Date;
}

// Narrowed public projection of CalendarEvent.
// Omits: created_by (Keycloak user UUID — personal identifier, GDPR Art. 5(1)(c)),
//        caldav_uid and caldav_synced_at (internal CalDAV sync data, no public purpose).
export interface PublicCalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: Date;
  end_at: Date;
  all_day: boolean;
  event_type_id: string | null;
  is_multi_committee: boolean;
  source: 'manual' | 'helios' | 'minutes' | 'holiday' | 'newsletter';
  external_id: string | null;
  created_at: Date;
  updated_at: Date;
  is_public: boolean;
}

// NewsPost without author_id (internal Keycloak UUID — not for public exposure).
export interface PublicNewsPost {
  id: number;
  title: string;
  slug: string;
  body_html: string;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// Beschluss (adopted resolution) projection for the public structured register
// (#320 Phase 3). Source rows: protocol_resolutions JOIN protocols JOIN org_units,
// restricted to result='passed', status='published', and all_members committees.
// protocol_id / protocol_title / committee_id / committee_name / meeting_date come
// from the joined published protocol + all_members org unit.
// Challenge state crosses the anonymous boundary ONLY as angefochten_count — the
// challenge substance (grounds), the challenger (raised_by), and the decision
// attribution (resolved_by, decision_note) are NEVER projected (GDPR Art. 5(1)(c)).
export interface PublicBeschluss {
  id: string;
  protocol_id: string;
  committee_id: string;
  committee_name: string;
  meeting_date: Date;
  protocol_title: string;
  global_nr: string | null;
  sequence_nr: number;
  text: string;
  // The register lists only adopted resolutions (result='passed'); the field is
  // kept in the projection so a consumer never has to assume it.
  result: 'passed' | 'rejected' | 'withdrawn';
  adoption_mode: 'tally' | 'acclamation';
  // Nullable (migration 054): an 'acclamation' row may carry NO tally (all three
  // NULL) — NULL means "unrecorded" and must never collapse to 0. Only a 'tally'
  // row is guaranteed all three counts.
  votes_yes: number | null;
  votes_no: number | null;
  votes_abstain: number | null;
  decided_at: Date | null;
  // Count of currently-OPEN challenges (migration 055) — a bare count only,
  // never who or why. Drives the 'Angefochten (N)' badge on the register.
  angefochten_count: number;
}

// Protocol projection for published records only.
// Omitted: status (exposes draft/submitted states), revision_notes, nextcloud_draft_path,
// nextcloud_published_path, guest_edit_enabled, approval_poll_id, created_by.
export interface PublicProtocol {
  id: string;
  committee_id: string;
  meeting_date: Date;
  title: string;
  body_html: string | null;
  pdf_nextcloud_path: string | null;
  created_at: Date;
  committee_name: string;
  pdf_url: string | null;
}
