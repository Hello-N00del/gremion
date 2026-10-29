// services/kernel-api/src/authz/events.ts — the grant events (DOMAIN:785-787),
// written to idt.outbox through enqueue(tx, ...) in the SAME transaction as the
// state change: a rollback leaves no event, a commit leaves exactly one row per
// change. Full-state payload; aggregate version = the row's row_version, so
// issue -> granted v1, activation -> granted again (higher), revoke -> revoked,
// expiry -> expired. Ids and keys only (TRD-154), no names.
import { enqueue } from '@gremion/events'
import type { Sql } from './tx.ts'

export type GrantEventType = 'granted' | 'revoked' | 'expired'

export interface GrantRow {
  grant_id: string
  body_id: string
  subject_person_id: string
  grant_kind: string
  role_key: string | null
  capability_key: string | null
  resource_kind: string | null
  resource_id: string | null
  valid_from: Date | string
  valid_until: Date | string | null
  granter_kind: string
  granted_by: string | null
  source: string
  state: string
  revoked_at: Date | string | null
  revoke_reason: string | null
  row_version: string | number
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString())

export async function emitGrantEvent(tx: Sql, type: GrantEventType, g: GrantRow): Promise<string> {
  return enqueue(tx, {
    eventType: `de.gremion.idt.grant.${type}.v1`,
    source: '/gremion/idt',
    subject: g.grant_id,
    aggregate: { type: 'grant', id: g.grant_id, version: Number(g.row_version) },
    data: {
      grant_id: g.grant_id,
      body_id: g.body_id,
      subject_person_id: g.subject_person_id,
      grant_kind: g.grant_kind,
      role_or_capability_key: g.role_key ?? g.capability_key,
      resource_kind: g.resource_kind,
      resource_id: g.resource_id,
      valid_from: iso(g.valid_from),
      valid_until: iso(g.valid_until),
      granter_kind: g.granter_kind,
      granted_by: g.granted_by,
      source: g.source,
      state: g.state,
      revoked_at: iso(g.revoked_at),
      revoke_reason: g.revoke_reason,
    },
  })
}
