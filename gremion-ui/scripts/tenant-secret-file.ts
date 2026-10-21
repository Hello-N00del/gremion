// R33 residual (TASK-044 item 4). tenant-create runs as root (the image's builder
// stage); gremion-ui, kernel-api and the other readers run as the image's `node`
// user (uid/gid 1000) and mount the tenant secrets directory read-only. A
// root:root 0600 file is unreadable to them on Linux too (EACCES, proven on a
// named volume), so a file under the tenant secrets dir is handed to the reader
// uid:gid, still mode 0600. Files elsewhere (the provisioner credential) keep
// their root ownership.
import { chownSync } from 'node:fs'
import { relative, resolve, isAbsolute } from 'node:path'

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
