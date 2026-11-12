// src/lib/server/module-switch/pending.ts
// A confirmed module switch that waits for the second factor (table module_switch_pending, migration 0065).
//
// A module switch needs a fresh second factor. When the session has none, the settings page sends the
// browser to the sign-in service and back, and everything the page held is gone by then. So the server
// keeps the confirmed input for that round trip, and the page asks for it to be carried out when it is
// back (POST /api/settings/modules { resume: true }).
//
// What makes that safe:
//   - the browser holds only a random handle, in an HttpOnly, SameSite=Strict cookie scoped to the module
//     API path. The row is found by the handle's SHA-256, so the table alone never yields a usable handle;
//   - the row names the person who confirmed; nobody else can carry it out;
//   - the row is single-use: claimPendingSwitch removes it in the statement that reads it, whatever the
//     checks afterwards say, so a second presentation of the same handle finds nothing;
//   - it expires on the database clock after PENDING_TTL_SECONDS;
//   - it is carried out only by a session whose second-factor time is NEWER than the one that confirmed,
//     and the switch service then runs its whole guard chain again, the fresh second factor included;
//   - the platform request is submitted under the key fixed at confirmation, so the same confirmed switch
//     can never become two platform requests.
//
// Every function takes the TENANT pool and never opens one.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Sql } from '@gremion/db'
import { SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'
import type { SwitchInput } from './service'

/** The cookie that carries the handle. Path-scoped: only the module switch endpoint ever receives it. */
export const PENDING_COOKIE = 'gremion_module_switch_pending'
export const PENDING_COOKIE_PATH = '/api/settings/modules'
/** How long a confirmed switch waits for the second factor (the same window as the step-up freshness default). */
export const PENDING_TTL_SECONDS = 300

const CONFIRM_MAX = 200
const DOCUMENT_REF_MAX = 500
/** 32 random bytes, base64url. */
const HANDLE_SHAPE = /^[A-Za-z0-9_-]{43}$/

export interface PendingSwitch {
  userId: string
  /** The second-factor time (epoch seconds, 0 for none) of the session that confirmed. */
  armedAuthTime: number
  input: SwitchInput
  /** The key the platform request is submitted under. */
  idempotencyKey: string
  /** False once the database clock is past the row's expiry. */
  live: boolean
}

/**
 * The confirmed input in the one shape that is kept: only the known fields, with their types and lengths
 * checked. Anything else (an unknown module, a wrong type, an oversized text) is not kept at all; the
 * switch service still validates the full input when the switch is carried out.
 */
export function normalizePendingInput(body: unknown): SwitchInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  const { moduleId, action, confirm, dpia } = raw
  if (typeof moduleId !== 'string' || !SWITCHABLE_CATALOGUE_IDS.has(moduleId)) return null
  if (action !== 'enable' && action !== 'disable') return null
  const input: SwitchInput = { moduleId, action }
  if (confirm !== undefined) {
    if (typeof confirm !== 'string' || confirm.length > CONFIRM_MAX) return null
    input.confirm = confirm
  }
  if (dpia !== undefined && dpia !== null) {
    if (typeof dpia !== 'object' || Array.isArray(dpia)) return null
    const { requiresDpia, documentRef } = dpia as Record<string, unknown>
    if (typeof requiresDpia !== 'boolean' || typeof documentRef !== 'string' || documentRef.length > DOCUMENT_REF_MAX) return null
    input.dpia = { requiresDpia, documentRef }
  }
  return input
}

const hashOf = (handle: string): string => createHash('sha256').update(handle, 'utf8').digest('hex')

/** Epoch seconds as a whole, non-negative number; anything else reads as "no second factor yet" (0). */
function wholeSeconds(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export interface ArmDeps {
  /** Injectable for tests. */
  newHandle?: () => string
  newKey?: () => string
}

/**
 * Keep a confirmed switch for the second-factor round trip and return the handle for the cookie. The
 * person's earlier row (if any) and every expired row are removed in the same transaction, so a person
 * has at most one confirmed switch waiting. `input` must come from normalizePendingInput.
 */
export async function armPendingSwitch(db: Sql, entry: { userId: string; authTime: number; input: SwitchInput }, deps: ArmDeps = {}): Promise<string> {
  if (entry.userId === '') throw new Error('a confirmed switch needs the person who confirmed it')
  const handle = (deps.newHandle ?? (() => randomBytes(32).toString('base64url')))()
  if (!HANDLE_SHAPE.test(handle)) throw new Error('the handle of a confirmed switch has the wrong shape')
  const key = (deps.newKey ?? randomUUID)()
  await db.begin(async (trx) => {
    const tx = trx as unknown as Sql
    // One writer per person: the delete and the insert below cannot interleave with a second confirmation.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'module_switch_pending:' + entry.userId}))`
    await tx`DELETE FROM module_switch_pending WHERE user_id = ${entry.userId} OR expires_at <= now()`
    await tx`
      INSERT INTO module_switch_pending (token_hash, idempotency_key, user_id, armed_auth_time, payload, expires_at)
      VALUES (${hashOf(handle)}, ${key}::uuid, ${entry.userId}, ${wholeSeconds(entry.authTime)},
              ${tx.json(entry.input as unknown as Parameters<typeof tx.json>[0])}::jsonb, now() + make_interval(secs => ${PENDING_TTL_SECONDS}))`
  })
  return handle
}

interface ClaimedRow {
  token_hash: string
  user_id: string
  armed_auth_time: string
  payload: unknown
  idempotency_key: string
  live: boolean
}

/**
 * Take the confirmed switch a handle names. The row is REMOVED by this call whatever the caller decides
 * next (single-use); expired rows of the tenant go with it. Resolves null when the handle is malformed,
 * unknown or already used, or when the stored input no longer has the kept shape.
 */
export async function claimPendingSwitch(db: Sql, handle: unknown): Promise<PendingSwitch | null> {
  if (typeof handle !== 'string' || !HANDLE_SHAPE.test(handle)) return null
  const hash = hashOf(handle)
  const rows = await db<ClaimedRow[]>`
    DELETE FROM module_switch_pending
     WHERE token_hash = ${hash} OR expires_at <= now()
    RETURNING token_hash, user_id, armed_auth_time::text AS armed_auth_time, payload, idempotency_key::text AS idempotency_key, (expires_at > now()) AS live`
  const row = rows.find((r) => r.token_hash === hash)
  if (!row) return null
  const input = normalizePendingInput(row.payload)
  if (input === null) return null
  return { userId: row.user_id, armedAuthTime: Number(row.armed_auth_time), input, idempotencyKey: row.idempotency_key, live: row.live === true }
}

export type PendingRefusal = 'gone' | 'expired' | 'unconfirmed'
export type PendingCheck = { ok: true; pending: PendingSwitch } | { ok: false; reason: PendingRefusal }

/**
 * May this session carry the claimed switch out? `gone`: nothing was claimed, or it is another person's.
 * `expired`: past its expiry. `unconfirmed`: the session's second factor is not newer than the one the
 * switch was confirmed with, so no second-factor confirmation happened in between. The freshness of the
 * second factor itself is the switch service's check; this one only ties the switch to a NEW confirmation.
 */
export function checkPendingSwitch(pending: PendingSwitch | null, user: { id: string; loa: number; authTime: number }, requiredLoa: number): PendingCheck {
  if (pending === null || user.id === '' || pending.userId !== user.id) return { ok: false, reason: 'gone' }
  if (!pending.live) return { ok: false, reason: 'expired' }
  if (user.loa < requiredLoa || !(wholeSeconds(user.authTime) > pending.armedAuthTime)) return { ok: false, reason: 'unconfirmed' }
  return { ok: true, pending }
}
