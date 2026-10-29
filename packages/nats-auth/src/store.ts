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
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createUser, fromSeed } from '@nats-io/nkeys'
import { assertModuleId, assertTenantId } from './permissions.ts'

export const ADMIN_DIR = '_admin'
export const SYS_DIR = '_sys'
export const SYS_RELOAD_FILE = 'reload.nk'
const TENANT_FILE_RE = /^tenant_([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.nk$/
const TMP_RE = /\.tmp-\d+-[0-9a-f]+$/

/**
 * Identities whose seeds are read by a container of their own (not by tenant-create), and the uid/gid that
 * container runs as. tenant-create runs as root and writes the volume; for these identities the owner
 * directory and its seed files are handed to the image's user (mode unchanged: 0700 dir, 0600 seeds), so
 * the container reads exactly its own subtree and nobody else's. Only kernel-api today: the kernel API
 * mounts the volume's kernel-api/ subpath read-only (docker-compose.app.yml) and runs as `node`, uid/gid
 * 1000 of the official node image (services/kernel-api/Dockerfile `USER node`; test: kernel-api-dir.test.ts).
 */
export const IMAGE_OWNERS: Readonly<Record<string, Readonly<{ uid: number; gid: number }>>> = Object.freeze({
  'kernel-api': Object.freeze({ uid: 1000, gid: 1000 }),
})

export interface SeedStoreOptions {
  /** Test seam: the ownership change (default fs.chownSync). */
  chown?: (file: string, uid: number, gid: number) => void
  /** Test seam: only root can hand a file to another uid (default: process.getuid() === 0; false where there is no uid). */
  isRoot?: () => boolean
}

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

/** A seed's name as the store spells it everywhere (`<owner>/tenant_<t>.nk`), whatever the platform separator. */
const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/')

function writeFileSyncSafe(file: string, text: string): void {
  const fd = openSync(file, 'wx', 0o600)
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

export class SeedStore {
  private readonly chownFn: (file: string, uid: number, gid: number) => void
  private readonly isRoot: () => boolean

  constructor(
    readonly root: string,
    opts: SeedStoreOptions = {},
  ) {
    this.chownFn = opts.chown ?? chownSync
    this.isRoot = opts.isRoot ?? (() => process.getuid?.() === 0)
  }

  /** Hands a path of an image-owned identity to the image's uid/gid (root only); a failure fails the run, never leaves a root-owned seed unreadable to its container. */
  private handOver(owner: string, file: string): void {
    const id = IMAGE_OWNERS[owner]
    if (!id || !this.isRoot()) return
    try {
      this.chownFn(file, id.uid, id.gid)
    } catch (err) {
      fail(`cannot hand ${rel(this.root, file)} (the ${owner} identity) to uid ${id.uid}:${id.gid}, the user its container runs as -- it could not read its own seed`, err)
    }
  }

  /** Creates an identity's owner directory (0700) without a seed in it: the subpath a container mounts must exist before the container is created. */
  ensureOwnerDir(owner: string): void {
    assertModuleId(owner)
    this.dir(owner)
  }

  private dir(sub: string): string {
    const d = path.join(this.root, sub)
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 })
      chmodSync(d, 0o700)
    } catch (err) {
      fail(`cannot create the seed directory ${d}`, err)
    }
    this.handOver(sub, d)
    return d
  }

  /** Read a seed file; it must hold a USER seed. */
  read(file: string): Seed {
    let text: string
    try {
      text = readFileSync(file, 'utf8').trim()
    } catch (err) {
      fail(`cannot read seed ${rel(this.root, file)} under ${this.root}`, err)
    }
    try {
      const seed = te.encode(text)
      const kp = fromSeed(seed)
      const publicKey = kp.getPublicKey()
      if (!publicKey.startsWith('U')) throw new Error('not a user key')
      return { seed, publicKey, created: false }
    } catch {
      fail(`${rel(this.root, file)} is not a user seed -- refusing to replace it (that would cut the identity's live connection); inspect and remove it by hand`)
    }
  }

  private write(owner: string, dir: string, name: string): Seed {
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
      fail(`cannot write seed ${rel(this.root, final)} under ${this.root}`, err)
    }
    this.handOver(owner, final)
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
      this.handOver(sub, f)
      return s
    }
    return this.write(sub, d, name)
  }

  /**
   * One nats-auth run at a time across every container that mounts this
   * store: two tenant-create runs rendering concurrently would each write an
   * accounts file missing the other's users (a lost update), and a sweep
   * would remove the other's in-flight temp seed. mkdir is atomic; a lock
   * older than `staleMs` (a run that died) is taken over. Returns release().
   */
  lock(staleMs = 10 * 60_000): () => void {
    const p = path.join(this.dir(SYS_DIR), '.lock')
    const take = () => {
      mkdirSync(p, { mode: 0o700 })
      const stamp = `${process.pid}-${randomBytes(4).toString('hex')}`
      writeFileSyncSafe(path.join(p, 'owner'), stamp)
      return stamp
    }
    let stamp: string
    try {
      stamp = take()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') fail(`cannot take the lock ${p}`, err)
      const age = Date.now() - statSync(p).mtimeMs
      if (age <= staleMs) fail(`another nats-auth run holds ${p} (taken ${Math.round(age / 1000)} s ago); if none is running, remove it`)
      rmSync(p, { recursive: true, force: true })
      try {
        stamp = take()
      } catch (err2) {
        fail(`another nats-auth run took over the stale lock ${p} first`, err2)
      }
    }
    return () => {
      // release only our own lock: a run that took over a stale one owns it now
      let owner = ''
      try {
        owner = readFileSync(path.join(p, 'owner'), 'utf8')
      } catch {
        return
      }
      if (owner === stamp) rmSync(p, { recursive: true, force: true })
    }
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
