// src/lib/server/messages/register.server.ts
// Civitas Session-A inversion A1/A3a: the messages module self-registers its
// server-side contributions into the runtime-registry seam, so the kernel
// (tenant/registry.ts evict path + governance orchestrator + the shell layout
// load's unread badge) never imports messages internals. Loaded for its side
// effects by the generated server-init barrel (scripts/build-module-server-init.mjs).
import {
  registerTenantEvictHook,
  registerProvisioningSubsystem,
  registerDataProvider,
  registerSetupHealthProbe,
  registerErasureHook,
} from '$lib/server/modules/runtime-registry'
import { serviceEnv } from '$lib/server/env/service-env'
import { evictMatrixClient } from './matrix-client'
import { getMatrixClient } from './matrix-client'
import { evictSynapseAdmin } from './synapse-admin'
import { getSynapseAdmin } from './synapse-admin'
import { evictLivekitSettings } from './livekit-client'
import { evictServiceMatrixTokenCache } from './backend/service-client'
import { createMatrixSubsystem } from './provisioning/matrix-subsystem'
import { messagingErasureHook } from './erasure'

// Per-tenant runtime handles the messages module caches. The tenant registry's
// evictTenantRuntime runs these on the suspend/delete lifecycle seam.
registerTenantEvictHook(evictMatrixClient)
registerTenantEvictHook(evictSynapseAdmin)
registerTenantEvictHook(evictLivekitSettings)
// #389: the service-mode (MESSAGES_BACKEND=service) Matrix token cache — a no-op
// in inprocess mode (cache empty), evicted here for parity with evictMatrixClient.
registerTenantEvictHook(evictServiceMatrixTokenCache)

// The Matrix provisioning adapter. The factory captures the messages module's
// own Matrix/Synapse clients and per-tenant server name; the governance
// orchestrator passes the per-tenant KC-admin client at build time.
registerProvisioningSubsystem('matrix', (kc) =>
  createMatrixSubsystem(
    { matrix: getMatrixClient(), synapse: getSynapseAdmin(), kc },
    serviceEnv('SYNAPSE_SERVER_NAME') ?? 'localhost',
  ),
)

// Shell unread badge (was loadUnread in +layout.server): a single short `/sync`
// against Synapse, summing each room's notification_count. We reuse the Keycloak
// access token already on locals (G-006) to mint a cached Matrix token
// (matrix-client caches per user, so repeated navigations don't re-login). Caps
// the sync at 4 s so a slow homeserver can't stall a page navigation; degrades to
// 0 on any Matrix/auth error so a homeserver hiccup never blocks the shell.
registerDataProvider('messages:unread-count', async (accessToken) => {
  if (!accessToken) return 0
  try {
    const mc = getMatrixClient()
    const matrixToken = await mc.getMatrixToken(accessToken)
    // An initial /sync (no `since`) returns the current state snapshot without
    // long-polling, but we cap it anyway so a slow homeserver can never stall a
    // page navigation — the badge degrades to 0 rather than hanging the shell.
    const sync = await Promise.race([
      mc.sync(matrixToken),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('matrix sync timeout')), 4000),
      ),
    ])
    return sync.rooms.reduce((sum, r) => sum + (r.unreadCount ?? 0), 0)
  } catch {
    return 0
  }
})

// D11 notification popover chat rows: the rooms with unread messages (display
// name + count + last activity), from the same capped short /sync the
// unread-count badge uses (sync() folds in the per-room unread *message* counts,
// so the row counts always agree with the badge total). Room display names come
// from each room's m.room.name state, read through the SAME tenant-keyed client
// that minted the token (mc.getRoomName) — never a hand-built default-env URL,
// which would transmit a non-default tenant's per-user Matrix token to the
// DEFAULT tenant's homeserver (design v11 review). Degrades to [] on any
// Matrix/auth error so a homeserver hiccup never breaks the popover.
registerDataProvider('messages:unread-rooms', async (accessToken) => {
  if (!accessToken) return []
  try {
    const mc = getMatrixClient()
    const matrixToken = await mc.getMatrixToken(accessToken)
    const sync = await Promise.race([
      mc.sync(matrixToken),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('matrix sync timeout')), 4000),
      ),
    ])
    const unreadRooms = sync.rooms.filter((r) => (r.unreadCount ?? 0) > 0).slice(0, 10)
    return await Promise.all(
      unreadRooms.map(async (r) => {
        // getRoomName degrades to null on any error — keep the room id then.
        const name = (await mc.getRoomName(matrixToken, r.roomId)) ?? r.roomId
        const lastTs = r.events.reduce((max, e) => Math.max(max, e.ts), 0)
        return {
          roomId: r.roomId,
          name,
          unread: r.unreadCount ?? 0,
          lastTs: lastTs > 0 ? lastTs : null,
        }
      }),
    )
  } catch {
    return []
  }
})

// A3c S2: setup-wizard credential probe for Synapse (#191). The setup-health
// route iterates the registered probes instead of importing synapse-admin, so it
// reports `credentials.synapse` from this module's own admin client.
registerSetupHealthProbe({
  service: 'synapse',
  validate: () => getSynapseAdmin().validateCredentials(),
})

// TRD-196: the messaging module's data-subject erasure step (the Matrix account,
// via the Synapse admin API).
registerErasureHook(messagingErasureHook)
