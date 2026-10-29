// services/kernel-api/src/outbox/nats.ts -- the real NATS opener of the relay
// host: the kernel-api identity of one customer (natsConnectOptionsFor reads the
// seed from NATS_SECRETS_DIR, default /run/secrets/nats), a reconnecting
// connection, and its JetStream client. Lazy: nothing connects at import or at
// construction (routes:check boots the app with no environment).
import { natsConnectOptionsFor } from '@gremion/nats-auth'
import { jetstream } from '@nats-io/jetstream'
import { connect } from '@nats-io/transport-node'
import type { TenantRow } from '../app/deps.ts'
import type { JetStreamHandle } from './relay-host.ts'

/** The NATS identity of the kernel API (packages/nats-auth FLOWS key). */
export const KERNEL_API_NATS_IDENTITY = 'kernel-api'

export interface NatsOpenerOptions {
  /** NATS_URL */
  url: string
  /** NATS_SECRETS_DIR (default /run/secrets/nats). */
  secretsDir?: string
  connectTimeoutMs?: number
}

export function natsOpener(o: NatsOpenerOptions): (tenant: TenantRow) => Promise<JetStreamHandle> {
  return async (tenant) => {
    const opts = natsConnectOptionsFor(tenant.slug, KERNEL_API_NATS_IDENTITY, o.secretsDir ? { secretsDir: o.secretsDir } : {})
    const nc = await connect({ servers: o.url, ...opts, timeout: o.connectTimeoutMs ?? 5_000, maxReconnectAttempts: -1 })
    return {
      js: jetstream(nc),
      close: async () => {
        await nc.drain().catch(() => undefined)
      },
    }
  }
}
