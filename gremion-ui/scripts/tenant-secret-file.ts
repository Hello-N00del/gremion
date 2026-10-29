// R33 residual (TASK-044 item 4). tenant-create runs as root (the image's builder
// stage); gremion-ui, kernel-api and the other readers run as the image's `node`
// user (uid/gid 1000) and mount the tenant secrets directory read-only. A
// root:root 0600 file is unreadable to them on Linux too (EACCES, proven on a
// named volume), so a file under the tenant secrets dir is handed to the reader
// uid:gid, still mode 0600. Files elsewhere (the provisioner credential) keep
// their root ownership.
import { chownSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, isAbsolute } from 'node:path'

export function readerIds(env: Record<string, string | undefined>): { uid: number; gid: number } {
  const one = (name: string): number => {
    const v = env[name]
    if (v === undefined || v === '') return 1000
    if (!/^\d+$/.test(v)) throw new Error(`${name} must be a numeric id, got "${v}"`)
    return Number(v)
  }
  return { uid: one('TENANT_SECRETS_UID'), gid: one('TENANT_SECRETS_GID') }
}

export function handToReader(
  hostPath: string,
  secretsDir: string,
  deps: { chown?: (path: string, uid: number, gid: number) => void; env?: Record<string, string | undefined> } = {}
): void {
  const rel = relative(resolve(secretsDir), resolve(hostPath))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
  const { uid, gid } = readerIds(deps.env ?? process.env)
  try {
    ;(deps.chown ?? chownSync)(hostPath, uid, gid)
  } catch (err) {
    // Fatal: a file left root:root 0600 under the secrets dir is unreadable to
    // every reader container (EACCES at runtime, long after the create "passed").
    throw new Error(`chown ${uid}:${gid} ${hostPath} failed (${err instanceof Error ? err.message : String(err)}); the reader container would get EACCES`)
  }
}

type ReaderDeps = {
  chown?: (path: string, uid: number, gid: number) => void
  env?: Record<string, string | undefined>
  pid?: number
}

// #49: the tenant's config.json and its per-slug directory under the data root.
// tenant-create (root) made both root:root, the file 0640, and gremion-ui (uid
// 1000) got EACCES on config.json: an incomplete brand identity, a failed
// readiness, and a new customer answering 503. The file is written as a tmp,
// handed to the reader BEFORE the rename (it never appears root-owned), and the
// slug directory is handed over too. Mode stays 0640.
export function writeReaderConfigFile(path: string, text: string, deps: ReaderDeps = {}): void {
  const { uid, gid } = readerIds(deps.env ?? process.env)
  const chown = deps.chown ?? chownSync
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${deps.pid ?? process.pid}`
  writeFileSync(tmp, text, { mode: 0o640 })
  for (const p of [tmp, dir]) {
    try {
      chown(p, uid, gid)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw new Error(`chown ${uid}:${gid} ${p} failed (${err instanceof Error ? err.message : String(err)}); gremion-ui would get EACCES on the tenant config`)
    }
  }
  renameSync(tmp, path)
}
