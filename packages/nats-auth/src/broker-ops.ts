// packages/nats-auth/src/broker-ops.ts (@gremion/nats-auth)
//
// What ensureTenantAccount() asks of the running broker, over the network
// only (Q5: no Docker socket):
//  - reload(): as the SYS reload user, find the server ($SYS.REQ.SERVER.PING)
//    and ask it to re-read its config ($SYS.REQ.SERVER.<id>.RELOAD). A reply
//    carrying an error (the server rejected the file) fails loudly.
//  - ensureStreams(): as the tenant's admin, wait until the account answers
//    $JS.API.INFO, then ensureStream() each stream with the SAME builder the
//    modules use (NatsBroker), so their read-only check at boot finds an
//    equal config and writes nothing.
// Every connection is retried a bounded number of times (the broker may not
// be up yet: no depends_on across projects), then fails naming the url.
import { connect } from '@nats-io/transport-node'
import { nkeyAuthenticator, type NatsConnection } from '@nats-io/nats-core'
import { jetstreamManager } from '@nats-io/jetstream'
import { STREAMS } from '@gremion/ports/broker'
import { NatsBroker } from '@gremion/ports/nats'
import { adminConnectOptionsFor, type ConnectOptions, sysReloadConnectOptions } from './connect.ts'
import type { BrokerOps } from './ensure.ts'

export interface BrokerOpsOptions {
  url: string
  secretsDir?: string
  /** Connection attempts before failing (default 30). */
  attempts?: number
  /** Delay between attempts in ms (default 1000). */
  delayMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function withRetry<T>(what: string, url: string, attempts: number, delayMs: number, fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (i < attempts) await sleep(delayMs)
    }
  }
  throw new Error(`[nats-auth] ${what} at ${url} failed after ${attempts} attempts: ${msg(last)}`, { cause: last })
}

async function open(url: string, o: ConnectOptions): Promise<NatsConnection> {
  return connect({ servers: url, ...o, reconnect: false, timeout: 5_000 })
}

export function natsBrokerOps(opts: BrokerOpsOptions): BrokerOps {
  const attempts = opts.attempts ?? 30
  const delayMs = opts.delayMs ?? 1_000
  const loc = { secretsDir: opts.secretsDir }
  return {
    async reload() {
      const nc = await withRetry('connecting as the SYS reload user', opts.url, attempts, delayMs, () => open(opts.url, sysReloadConnectOptions(loc)))
      try {
        const ping = await nc.request('$SYS.REQ.SERVER.PING', '', { timeout: 5_000 })
        const id = (ping.json() as { server?: { id?: string } }).server?.id
        if (!id) throw new Error(`[nats-auth] $SYS.REQ.SERVER.PING answered without a server id: ${ping.string()}`)
        const reply = await nc.request(`$SYS.REQ.SERVER.${id}.RELOAD`, '', { timeout: 10_000 })
        const body = reply.json() as { error?: { code?: number; description?: string } }
        if (body.error) throw new Error(`[nats-auth] the server refused the reload: ${body.error.description ?? JSON.stringify(body.error)}`)
      } finally {
        await nc.close()
      }
    },

    async assertRevoked(tenant, seeds) {
      const admitted: string[] = []
      for (const { module, seed } of seeds) {
        let err = ''
        try {
          const nc = await connect({ servers: opts.url, authenticator: nkeyAuthenticator(seed), reconnect: false, timeout: 5_000 })
          await nc.close()
        } catch (e) {
          err = msg(e)
        }
        if (!err.includes('Authorization Violation')) admitted.push(`${module}@${tenant}${err ? ` (${err})` : ''}`)
      }
      if (admitted.length) {
        throw new Error(`[nats-auth] dropped identities still admitted by the server after the reload: ${admitted.join(', ')} -- their seeds are kept; rerun`)
      }
    },

    async ensureStreams(tenant, streams) {
      const admin = adminConnectOptionsFor(tenant, loc)
      // The account exists once the reload returned; its JetStream may take a
      // moment. Both waits are bounded.
      await withRetry(`waiting for account T_${tenant} to answer $JS.API.INFO`, opts.url, attempts, delayMs, async () => {
        const nc = await open(opts.url, admin)
        try {
          await (await jetstreamManager(nc)).getAccountInfo()
        } finally {
          await nc.close()
        }
      })
      for (const name of streams) {
        const d = (STREAMS as Record<string, { name: string; subjects: string[] }>)[name]
        if (!d) throw new Error(`[nats-auth] unknown stream ${name}`)
        const b = await NatsBroker.connect(opts.url, d.name, admin)
        try {
          await b.ensureStream(d.name, [...d.subjects])
        } finally {
          await b.close()
        }
      }
    },
  }
}
