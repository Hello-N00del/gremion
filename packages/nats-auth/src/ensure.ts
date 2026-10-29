// packages/nats-auth/src/ensure.ts (@gremion/nats-auth)
//
// ensureTenantAccount({ tenant, modules }): the idempotent, DECLARATIVE
// function the provisioning entrypoint (L3-11) calls (Q8). `modules` is the
// tenant's enabled catalogue set; the kernel is always added. The result is
// that set, exactly:
//
//  1. every module is in FLOWS or NO_BROKER, else fail before touching anything
//     (a NO_BROKER module gets no user);
//  2. the admin seed, then each flow module's seed, read or created (the seed
//     is the truth: a crash anywhere converges on the next run);
//  3. seeds of modules no longer in the set are deleted -- never under _admin
//     or _sys. An empty set suspends the tenant's modules (kernel stays);
//  4. the accounts file is re-rendered from ALL seeds; if its bytes are
//     unchanged AND the server is known to have loaded them, nothing is
//     written and nothing reloaded (reloaded:false). Otherwise it is written
//     atomically and the server reloaded; the "loaded" marker is written only
//     after the reload succeeded, so a run that dies between the two reloads
//     on the next;
//  5. as the tenant admin, every stream a user of this tenant touches is
//     ensured (same config builder as the modules' boot, so theirs is a read),
//     plus the tenant's system streams (SYSTEM_STREAMS: the DLQ, TASK-079).
//
// A dropped module's live connection is closed by the server on reload with
// Authorization Violation, and its old seed is refused from then on (I3).
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_ACCOUNTS_DIR, secretsDirOf } from './connect.ts'
import { FLOWS, KERNEL, NO_BROKER, SYSTEM_STREAMS } from './flows.ts'
import { accountFor, assertTenantId } from './permissions.ts'
import { renderServerConfig, type ServerState } from './render.ts'
import { ADMIN_DIR, IMAGE_OWNERS, SeedStore } from './store.ts'

export interface BrokerOps {
  /** Ask the running server to re-read its config. */
  reload(): Promise<void>
  /** As the tenant admin, ensure each stream exists with the modules' config. */
  ensureStreams(tenant: string, streams: string[]): Promise<void>
  /** Each dropped identity's seed must now be REFUSED by the server; throws
   *  naming any the server still admits. */
  assertRevoked(tenant: string, seeds: { module: string; seed: Uint8Array }[]): Promise<void>
}

export interface EnsureOptions {
  secretsDir?: string
  /** Where the accounts file lives (NATS_ACCOUNTS_DIR, default /etc/nats/accounts). */
  accountsDir?: string
  /** The running broker. Default: natsBrokerOps({ url: NATS_URL }). */
  broker?: BrokerOps
}

export interface EnsureResult {
  accountRef: string
  createdUsers: string[]
  removedUsers: string[]
  reloaded: boolean
}

export const ACCOUNTS_FILE = 'accounts.conf'
/** sha256 of the accounts file bytes the server last reloaded successfully. */
export const LOADED_MARKER = '.loaded.sha256'

const accountsDirOf = (o: { accountsDir?: string }): string => o.accountsDir ?? process.env.NATS_ACCOUNTS_DIR ?? DEFAULT_ACCOUNTS_DIR
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function readOr(file: string, fallback: string | undefined): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : fallback
}

function writeAtomic(file: string, text: string, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(tmp, text, { mode })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new Error(`[nats-auth] cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

/** The whole server state, from the public keys of every seed in the store. */
export function stateFromStore(store: SeedStore, exclude: { tenant: string; modules: readonly string[] } = { tenant: '', modules: [] }): ServerState {
  // A module seed for a tenant without an admin seed cannot be rendered into
  // an account; it is a half-created tenant -- fail rather than drop it.
  const orphans = store.orphans()
  if (orphans.length) {
    throw new Error(`[nats-auth] module seed(s) without a tenant admin seed: ${orphans.join(', ')} -- rerun ensure for that tenant or remove them by hand`)
  }
  const tenants = store.tenants().map((tenant) => ({
    tenant,
    admin: store.seedFor(ADMIN_DIR, tenant).publicKey,
    modules: Object.fromEntries(
      store
        .modulesOf(tenant)
        .filter((m) => !(tenant === exclude.tenant && exclude.modules.includes(m)))
        .map((m) => {
          // A module that left FLOWS (NO_BROKER, renamed) cannot be rendered;
          // say which seed blocks every tenant and how to clear it.
          if (!(m in FLOWS)) {
            throw new Error(`[nats-auth] ${m}/tenant_${tenant}.nk belongs to a module no longer in FLOWS -- re-ensure tenant ${tenant} without it (or remove that seed by hand)`)
          }
          return [m, store.seedFor(m, tenant).publicKey]
        }),
    ),
  }))
  return { sysReload: store.sysReload().publicKey, tenants }
}

/** The users one tenant should have for this module set (kernel always). */
export function usersFor(modules: readonly string[]): string[] {
  const users = new Set<string>([KERNEL])
  for (const m of modules) {
    if (m in FLOWS) users.add(m)
    else if (!NO_BROKER.ids.includes(m)) {
      throw new Error(`[nats-auth] module ${m} is in neither FLOWS nor NO_BROKER -- classify it in packages/nats-auth/src/flows.ts before provisioning it`)
    }
  }
  return [...users].sort()
}

/** Every stream any of these users publishes or consumes. */
export function streamsFor(users: readonly string[]): string[] {
  const s = new Set<string>()
  for (const u of users) for (const x of [...FLOWS[u]!.publishes, ...FLOWS[u]!.consumes]) s.add(x)
  return [...s].sort()
}

/** `nats-auth init`: the SYS reload seed and an accounts file rendered from
 *  the store (SYS-only on a fresh volume). Idempotent; no network. */
export async function initAccounts(opts: { secretsDir?: string; accountsDir?: string } = {}) {
  const store = new SeedStore(secretsDirOf(opts))
  const release = store.lock()
  try {
    const sys = store.ensureSysReload()
    // A container that mounts an identity's subpath needs it to exist before the container is created (even
    // before the first customer): create the owner directories of the image-owned identities (kernel-api).
    for (const owner of Object.keys(IMAGE_OWNERS)) store.ensureOwnerDir(owner)
    const file = path.join(accountsDirOf(opts), ACCOUNTS_FILE)
    const bytes = renderServerConfig(stateFromStore(store))
    const wrote = readOr(file, undefined) !== bytes
    if (wrote) writeAtomic(file, bytes, 0o644)
    return { createdSysReload: sys.created, wrote, accountsFile: file }
  } finally {
    release()
  }
}

export async function ensureTenantAccount(
  input: { tenant: string; modules: readonly string[] },
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  const { tenant } = input
  assertTenantId(tenant)
  const users = usersFor(input.modules)
  const store = new SeedStore(secretsDirOf(opts))
  store.sysReload() // init must have run
  // Every precondition before the first write: a run that cannot reach the
  // broker must not change the store.
  let broker = opts.broker
  if (!broker) {
    const url = process.env.NATS_URL
    if (!url) throw new Error('[nats-auth] NATS_URL is unset -- tenant-create carries it (nats://nats-${STACK}:4222)')
    const { natsBrokerOps } = await import('./broker-ops.ts')
    broker = natsBrokerOps({ url, secretsDir: secretsDirOf(opts) })
  }

  const release = store.lock()
  try {
    // The subpath a container mounts exists on every stack, whatever this tenant's module set (see initAccounts).
    for (const owner of Object.keys(IMAGE_OWNERS)) store.ensureOwnerDir(owner)
    // Additive first: new seeds cannot hurt a live identity.
    const createdUsers: string[] = []
    if ((await store.ensureSeed(ADMIN_DIR, tenant)).created) createdUsers.push('admin')
    for (const u of users) if ((await store.ensureSeed(u, tenant)).created) createdUsers.push(u)
    // Removals stay PENDING -- rendered out, but their seeds kept -- until the
    // server has dropped the keys; a failure anywhere before that leaves them
    // for the rerun to report and remove.
    const pending = store.modulesOf(tenant).filter((m) => !users.includes(m))
    const pendingSeeds = pending.map((module) => ({ module, seed: store.seedFor(module, tenant).seed }))

    const dir = accountsDirOf(opts)
    const file = path.join(dir, ACCOUNTS_FILE)
    const marker = path.join(dir, LOADED_MARKER)
    const bytes = renderServerConfig(stateFromStore(store, { tenant, modules: pending }))
    const loaded = readOr(file, undefined) === bytes && readOr(marker, '')?.trim() === sha256(bytes)

    let reloaded = false
    if (!loaded) {
      if (readOr(file, undefined) !== bytes) writeAtomic(file, bytes, 0o644)
      try {
        await broker.reload()
      } catch (err) {
        throw new Error(
          `[nats-auth] ${file} was written but is NOT loaded by the server (rerun to retry the reload): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      reloaded = true
    }
    // The server's answer, not the reload reply, decides that a key is gone.
    if (pendingSeeds.length) await broker.assertRevoked(tenant, pendingSeeds)
    for (const m of pending) store.removeModuleSeed(m, tenant)

    // The flow streams, then the system streams (DLQ, TASK-079 G5): every tenant account holds the
    // dead-letter stream, created here by the tenant admin because no module key can.
    await broker.ensureStreams(tenant, [...streamsFor(users), ...Object.keys(SYSTEM_STREAMS)])
    // Only now is "the server serves these bytes" known: the tenant's admin
    // was admitted and every stream answered.
    if (!loaded) writeAtomic(marker, `${sha256(bytes)}\n`, 0o644)
    return { accountRef: accountFor(tenant), createdUsers: createdUsers.sort(), removedUsers: [...pending].sort(), reloaded }
  } finally {
    release()
  }
}
