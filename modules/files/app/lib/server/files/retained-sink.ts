// src/lib/server/files/retained-sink.ts
// Module Karenz (phase 2, Task 16): the files module's retained sink.
//
// A retained copy (sealed at switch-off, Task 10) is also published as a read-only document into a
// Nextcloud group folder, so the people who may read it find it beside their other files. The kernel's
// engine drives this as one retried step per (record, sink) (Task 11); this file only implements the
// sink contract: `available` and `publish`.
//
// The Nextcloud is ONE shared instance for every tenant, so every name is per tenant:
//   group folder   Aufbewahrung-<tenantId>              read-only for the readers' group
//   readers' group gremion-retained-<tenantId>          the role holders who may read retained records
//   writers' group gremion-retained-<tenantId>-w        the service account only (read-only for people
//                                                       means somebody still has to be able to write)
// The folder id and the readers' group id are stored in the tenant table retained_sink_state when the
// folder is created and used from there on. A folder is NEVER adopted by mount point or name: if the
// state row is missing and a folder with the tenant's mount point already exists, publish fails loudly
// (RetainedSinkError) instead of attaching a group to a folder that may belong to somebody else.
//
// publish() overwrites by filename, so the republish after an Art. 17 erasure replaces the earlier
// document and the person is no longer legible in it.
import type { Sql } from '@gremion/db'
import { readConfig } from '$lib/server/config'
import { serviceEnv } from '$lib/server/env/service-env'
import { listRoleHolders } from '$lib/server/governance/role-holders'
import type { RetainedSink } from '$lib/server/module-karenz/retained/extractors'
import type { TenantContext } from '$lib/server/tenant/context'
import { createNextcloudClient, type NextcloudClient } from './nextcloud-client'

/** The id the sink registers under and the key of its row in retained_sink_state. */
const SINK_ID = 'files'

/** The realm roles that may read retained records (catalogue: council-admin, Vorstand, finance, auditor, it-admin). */
export const RETAINED_READER_ROLES = ['council-admin', 'vorstand', 'finance', 'auditor', 'it-admin'] as const

/** Group folder permissions (Nextcloud bit mask: 1 read, 2 update, 4 create, 8 delete, 16 share). */
const PERMISSION_READ = 1
const PERMISSION_WRITE = 1 | 2 | 4 | 8

/** A failure of the sink that retrying will not fix by itself; its message names the tenant, never a host. */
export class RetainedSinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetainedSinkError'
  }
}

/** Only characters that are safe inside a Nextcloud group id and a WebDAV path segment; never mangled, so two tenants cannot collide. */
function assertTenantId(tenantId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
    throw new RetainedSinkError('the retained sink cannot name a Nextcloud folder for this tenant id (only letters, digits, "_" and "-" are allowed)')
  }
}

/** The group folder mount point of one tenant. */
export function retainedFolderName(tenantId: string): string {
  return `Aufbewahrung-${tenantId}`
}

/** The Nextcloud group of the people who may read one tenant's retained copies. */
export function retainedReaderGroup(tenantId: string): string {
  return `gremion-retained-${tenantId}`
}

/** The service account's own group, derived from the STORED readers' group id. */
function writerGroupOf(readerGroupId: string): string {
  return `${readerGroupId}-w`
}

interface SinkState {
  folderId: number
  readerGroup: string
}

function adminUser(): string {
  return serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'
}

async function readState(db: Sql): Promise<SinkState | null> {
  const rows = await db<{ external_id: string; group_id: string }[]>`
    SELECT external_id, group_id FROM retained_sink_state WHERE sink = ${SINK_ID}`
  const row = rows[0]
  if (!row) return null
  const folderId = Number(row.external_id)
  if (!Number.isInteger(folderId) || folderId <= 0) {
    throw new RetainedSinkError('the stored retained folder id is not a Nextcloud folder id')
  }
  return { folderId, readerGroup: row.group_id }
}

/**
 * The tenant's sink state, creating the folder and the groups on the first publish. The whole creation
 * runs under a database lock keyed on the sink and ends with the state row in the same transaction, so
 * two app instances never create two folders. A crash between the creation of the folder and the state
 * row leaves a stray folder; the next attempt REFUSES it (never adopts it) and says so.
 */
async function ensureState(tenant: TenantContext, nc: NextcloudClient): Promise<SinkState> {
  const known = await readState(tenant.db)
  if (known) return known

  return tenant.db.begin(async (tx) => {
    const db = tx as unknown as Sql
    await db`SELECT pg_advisory_xact_lock(hashtext(${'retained-sink:' + SINK_ID}))`
    const again = await readState(db)
    if (again) return again

    const mount = retainedFolderName(tenant.id)
    if ((await nc.listGroupFolders()).some((f) => f.mountPoint === mount)) {
      throw new RetainedSinkError(
        `a Nextcloud group folder "${mount}" exists but tenant ${tenant.id} has no retained_sink_state row; it is not adopted: ` +
        'remove that folder (or record its ids in retained_sink_state) and the next pass publishes again',
      )
    }
    const readerGroup = retainedReaderGroup(tenant.id)
    const writerGroup = writerGroupOf(readerGroup)
    // the idempotent parts first: a failure here leaves nothing that blocks a retry
    await nc.createGroup(readerGroup)
    await nc.createGroup(writerGroup)
    await nc.addUserToGroup(adminUser(), writerGroup)
    const folder = await nc.createGroupFolder(mount)
    await nc.assignGroupFolderPermissions(folder.id, readerGroup, PERMISSION_READ)
    await nc.assignGroupFolderPermissions(folder.id, writerGroup, PERMISSION_WRITE)
    const inserted = await db<{ external_id: string }[]>`
      INSERT INTO retained_sink_state (sink, external_id, group_id)
      VALUES (${SINK_ID}, ${String(folder.id)}, ${readerGroup})
      ON CONFLICT (sink) DO NOTHING
      RETURNING external_id`
    if (inserted.length === 0) throw new RetainedSinkError(`tenant ${tenant.id}: another run recorded the retained folder first; the next attempt uses that one`)
    return { folderId: folder.id, readerGroup }
  })
}

/**
 * Make the readers' group of this tenant equal to the people who hold a reading role now: add the new
 * holders (after giving them a Nextcloud account), remove the former ones. Only this tenant's group is
 * touched. Every operation is tried; a failure of one does not skip the rest, and the sync then fails so
 * the engine retries it.
 */
async function syncReaders(tenant: TenantContext, nc: NextcloudClient, readerGroup: string): Promise<void> {
  const { holders } = await listRoleHolders(tenant, RETAINED_READER_ROLES) // a Keycloak failure throws: no partial list
  const desired = new Map(holders.map((hd) => [hd.userId, hd]))
  const current = new Set(await nc.listGroupMembers(readerGroup))
  const providerId = Number(serviceEnv('NEXTCLOUD_OIDC_PROVIDER_ID') ?? '1')

  let failed = 0
  for (const hd of desired.values()) {
    if (current.has(hd.userId)) continue
    try {
      // the group call 404s for a user without a Nextcloud account
      await nc.provisionOidcUser({ providerId, userId: hd.userId, displayName: hd.displayName, email: hd.email })
      await nc.addUserToGroup(hd.userId, readerGroup)
    } catch (err) {
      failed++
      console.error(`[karenz/files] adding a reader to the retained group of tenant ${tenant.id} failed:`, err)
    }
  }
  for (const userId of current) {
    if (desired.has(userId)) continue
    try {
      await nc.removeUserFromGroup(userId, readerGroup)
    } catch (err) {
      failed++
      console.error(`[karenz/files] removing a former reader from the retained group of tenant ${tenant.id} failed:`, err)
    }
  }
  if (failed > 0) throw new RetainedSinkError(`tenant ${tenant.id}: ${failed} membership change(s) of the retained group failed`)
}

export const filesRetainedSink: RetainedSink = {
  id: SINK_ID,

  /** Only while the files module is on: a switched-off files module has no folder view to publish into. */
  available(tenant) {
    return readConfig(tenant).modules?.files === true
  },

  async publish({ tenant, filename, ndjson }) {
    assertTenantId(tenant.id)
    const nc = createNextcloudClient()
    const state = await ensureState(tenant, nc)
    // the audience first, then the document: nothing is published to a group that is not in sync
    await syncReaders(tenant, nc, state.readerGroup)
    const user = adminUser()
    const path = `/remote.php/dav/files/${encodeURIComponent(user)}/${encodeURIComponent(retainedFolderName(tenant.id))}/${encodeURIComponent(filename)}`
    await nc.upload(path, user, new Uint8Array(ndjson), 'application/x-ndjson')
  },
}
