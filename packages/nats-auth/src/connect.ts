// packages/nats-auth/src/connect.ts (@gremion/nats-auth)
//
// natsConnectOptionsFor(tenant, module): the client identity a module passes
// to NatsBroker.connect(url, STREAMS.X.name, opts) -- its nkey authenticator,
// its own inbox prefix (the server refuses the shared _INBOX) and a connection
// name. The seed is read from the module's subtree of the nats-secrets volume
// (NATS_SECRETS_DIR, default /run/secrets/nats). Wiring the callers is
// TASK-079's (Q9); this is the function they call.
import { nkeyAuthenticator } from '@nats-io/nats-core'
import type { NatsConnectOptions } from '@gremion/ports/nats'
import { ADMIN_INBOX, inboxPrefixFor, SYS_INBOX } from './permissions.ts'
import { ADMIN_DIR, SeedStore } from './store.ts'

export const DEFAULT_SECRETS_DIR = '/run/secrets/nats'
export const DEFAULT_ACCOUNTS_DIR = '/etc/nats/accounts'

export interface StoreLocation {
  secretsDir?: string
}

export const secretsDirOf = (o: StoreLocation = {}): string => o.secretsDir ?? process.env.NATS_SECRETS_DIR ?? DEFAULT_SECRETS_DIR

export type ConnectOptions = Required<NatsConnectOptions>

export function natsConnectOptionsFor(tenant: string, module: string, loc: StoreLocation = {}): ConnectOptions {
  const s = new SeedStore(secretsDirOf(loc)).seedFor(module, tenant)
  return { authenticator: nkeyAuthenticator(s.seed), inboxPrefix: inboxPrefixFor(tenant, module), name: `${module}@${tenant}` }
}

export function adminConnectOptionsFor(tenant: string, loc: StoreLocation = {}): ConnectOptions {
  const s = new SeedStore(secretsDirOf(loc)).seedFor(ADMIN_DIR, tenant)
  return { authenticator: nkeyAuthenticator(s.seed), inboxPrefix: ADMIN_INBOX(tenant), name: `admin@${tenant}` }
}

export function sysReloadConnectOptions(loc: StoreLocation = {}): ConnectOptions {
  const s = new SeedStore(secretsDirOf(loc)).sysReload()
  return { authenticator: nkeyAuthenticator(s.seed), inboxPrefix: SYS_INBOX, name: 'nats-auth-reload' }
}
