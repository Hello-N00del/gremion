// packages/nats-auth/src/store.ts (@gremion/nats-auth)
//
// The seed store: the ${STACK}_nats_secrets volume at /run/secrets/nats (Q4).
//
//   <module>/tenant_<t>.nk   one user seed per (tenant, flow module), kernel/ too
//   _admin/tenant_<t>.nk     the tenant admin (streams, JetStream API)
//   _sys/reload.nk           the SYS reload user
//
// THE SEED IS THE TRUTH. The accounts file is always re-rendered from the
// public keys of the seeds present here, so a run that dies at any point
// converges on the next: a seed is written to a temp file (0600) and renamed
// into place, a leftover temp file is removed, an existing seed is never
// regenerated (a corrupt one fails loudly rather than being replaced -- that
// would silently cut the module's live connection). Directories are 0700,
// seeds 0600. Only tenant-create mounts this volume.
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createUser, fromSeed } from '@nats-io/nkeys'
import { assertModuleId, assertTenantId } from './permissions.ts'

export const ADMIN_DIR = '_admin'
export const SYS_DIR = '_sys'
export const SYS_RELOAD_FILE = 'reload.nk'
const TENANT_FILE_RE = /^tenant_([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.nk$/
const TMP_RE = /\.tmp-\d+-[0-9a-f]+$/

export interface Seed {
  /** The seed bytes (never logged, never rendered). */
  readonly seed: Uint8Array
  readonly publicKey: string
  readonly created: boolean
}

const td = new TextDecoder()
const te = new TextEncoder()

function fail(msg: string, cause?: unknown): never {
  throw new Error(`[nats-auth] ${msg}${cause instanceof Error ? `: ${cause.message}` : ''}`, cause ? { cause } : undefined)
}

export const tenantFile = (tenant: string): string => `tenant_${tenant}.nk`

export class SeedStore {
  constructor(readonly root: string) {}

  private dir(sub: string): string {
    const d = path.join(this.root, sub)
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 })
      chmodSync(d, 0o700)
    } catch (err) {
      fail(`cannot create the seed directory ${d}`, err)
    }
    return d
  }

  /** Read a seed file; it must hold a USER seed. */
  read(file: string): Seed {
    let text: string
    try {
      text = readFileSync(file, 'utf8').trim()
    } catch (err) {
      fail(`cannot read seed ${path.relative(this.root, file)} under ${this.root}`, err)
    }
    try {
      const seed = te.encode(text)
      const kp = fromSeed(seed)
      const publicKey = kp.getPublicKey()
      if (!publicKey.startsWith('U')) throw new Error('not a user key')
      return { seed, publicKey, created: false }
    } catch {
      fail(`${path.relative(this.root, file)} is not a user seed -- refusing to replace it (that would cut the identity's live connection); inspect and remove it by hand`)
    }
  }

  private write(dir: string, name: string): Seed {
    const kp = createUser()
    const seed = kp.getSeed()
    const final = path.join(dir, name)
    const tmp = `${final}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      const fd = openSync(tmp, 'wx', 0o600)
      try {
        writeSync(fd, `${td.decode(seed)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      chmodSync(tmp, 0o600)
      renameSync(tmp, final)
    } catch (err) {
      rmSync(tmp, { force: true })
      fail(`cannot write seed ${path.relative(this.root, final)} under ${this.root}`, err)
    }
    return { seed, publicKey: kp.getPublicKey(), created: true }
  }

  /** Remove temp files a crashed run left behind in one directory. */
  private sweep(dir: string): void {
    for (const f of readdirSync(dir)) if (TMP_RE.test(f)) rmSync(path.join(dir, f), { force: true })
  }

  private ensureIn(sub: string, name: string): Seed {
    const d = this.dir(sub)
    this.sweep(d)
    const f = path.join(d, name)
    if (existsSync(f)) {
      const s = this.read(f)
      if ((statSync(f).mode & 0o777) !== 0o600) chmodSync(f, 0o600)
      return s
    }
    return this.write(d, name)
  }

  /** The SYS reload seed, created if absent (nats-auth init). */
  ensureSysReload(): Seed {
    return this.ensureIn(SYS_DIR, SYS_RELOAD_FILE)
  }

  /** The SYS reload seed; absent means init never ran -- fail loudly. */
  sysReload(): Seed {
    const f = path.join(this.root, SYS_DIR, SYS_RELOAD_FILE)
    if (!existsSync(f)) fail(`${SYS_DIR}/${SYS_RELOAD_FILE} is absent under ${this.root} -- run \`nats-auth init\` first (Q12)`)
    return this.read(f)
  }

  /** A tenant's admin (`_admin`) or module/kernel seed, created if absent. */
  async ensureSeed(owner: string, tenant: string): Promise<Seed> {
    assertTenantId(tenant)
    if (owner !== ADMIN_DIR) assertModuleId(owner)
    return this.ensureIn(owner, tenantFile(tenant))
  }

  seedFor(owner: string, tenant: string): Seed {
    assertTenantId(tenant)
    if (owner !== ADMIN_DIR) assertModuleId(owner)
    const f = path.join(this.root, owner, tenantFile(tenant))
    if (!existsSync(f)) fail(`no seed ${owner}/${tenantFile(tenant)} under ${this.root}`)
    return this.read(f)
  }

  /** Module directories (never _admin/_sys) that hold a seed for this tenant. */
  modulesOf(tenant: string): string[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && existsSync(path.join(this.root, e.name, tenantFile(tenant))))
      .map((e) => e.name)
      .sort()
  }

  /** Every tenant with an admin seed. */
  tenants(): string[] {
    const d = path.join(this.root, ADMIN_DIR)
    if (!existsSync(d)) return []
    return readdirSync(d)
      .map((f) => TENANT_FILE_RE.exec(f)?.[1])
      .filter((t): t is string => t !== undefined)
      .sort()
  }

  /** Module seeds whose tenant has no admin seed: a half-created tenant. */
  orphans(): string[] {
    if (!existsSync(this.root)) return []
    const known = new Set(this.tenants())
    const out: string[] = []
    for (const e of readdirSync(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('_')) continue
      for (const f of readdirSync(path.join(this.root, e.name))) {
        const t = TENANT_FILE_RE.exec(f)?.[1]
        if (t !== undefined && !known.has(t)) out.push(`${e.name}/${f}`)
      }
    }
    return out.sort()
  }

  /** Delete a module's seed for one tenant. Never under _admin or _sys. */
  removeModuleSeed(module: string, tenant: string): void {
    assertModuleId(module)
    assertTenantId(tenant)
    if (module.startsWith('_')) fail(`refusing to delete under ${module}`)
    try {
      rmSync(path.join(this.root, module, tenantFile(tenant)))
    } catch (err) {
      fail(`cannot delete seed ${module}/${tenantFile(tenant)}`, err)
    }
  }
}
