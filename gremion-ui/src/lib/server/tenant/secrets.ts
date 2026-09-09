// src/lib/server/tenant/secrets.ts
// P2.1a — secret-ref resolver (spec §3.1: registry stores secret REFERENCES,
// never raw passwords). Two schemes: `file:<path>` (Docker secret / mounted
// file) and `env:<VAR>` (used by the `default` tenant so tenant #1 keeps its
// existing env secrets byte-identically). Fail-closed: unknown scheme or
// missing env var throws — never returns an empty secret silently.
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { env } from '$env/dynamic/private'

// P2.1c (T7) — file: refs come from the trusted control DB, but a registry-WRITE
// surface (the provisioner) now exists, so the ref is no longer beyond reach of
// operator/automation input. Constrain file: paths to the CONTAINER mount prefix
// (D-SECMOUNT: gremion-ui mounts ${TENANT_SECRETS_DIR} → /run/secrets/tenants, and
// Docker secrets land under /run/secrets) and reject any traversal that escapes
// it. Paths are container-side (POSIX) regardless of host OS, so normalize with
// posix.
const SECRET_PREFIX = '/run/secrets/'
const TENANT_SUBDIR = '/run/secrets/tenants/'

/** True iff `p` (already posix-normalized, absolute) is contained under `prefix`. */
function isUnder(p: string, prefix: string): boolean {
  return p.startsWith(prefix)
}

export function resolveSecret(ref: string): string {
  if (ref.startsWith('file:')) {
    const raw = ref.slice('file:'.length)
    // Normalize first (collapses `.`/`..`), THEN check the prefix — so a
    // traversal like /run/secrets/../x can never read outside the mount.
    const normalized = posix.normalize(raw)
    if (!isUnder(normalized, SECRET_PREFIX)) {
      throw new Error(`secret ref file:${raw} escapes the allow-listed ${SECRET_PREFIX} prefix`)
    }
    return readFileSync(normalized, 'utf-8').trim()
  }
  if (ref.startsWith('env:')) {
    const name = ref.slice('env:'.length)
    const val = env[name]
    if (val === undefined) throw new Error(`secret ref env:${name} is unset`)
    return val
  }
  throw new Error(`unsupported secret ref scheme: ${ref.split(':', 1)[0]}`)
}

/**
 * P2.1c (T7, D-SECMOUNT) — translate a per-tenant CONTAINER secret ref
 * (`file:/run/secrets/tenants/<name>`) to its HOST bind-mount source
 * (`${TENANT_SECRETS_DIR:-./secrets/tenants}/<name>`). HOST-side scripts (the
 * provisioner T10, backup T16) run operator-side where `/run/secrets` does not
 * exist, so they cannot use resolveSecret directly. Fail-closed: only refs under
 * the tenants subdir are accepted; anything else (other file: prefixes, traversal,
 * non-file: schemes) is refused.
 */
export function tenantSecretHostPath(ref: string): string {
  if (!ref.startsWith('file:')) {
    throw new Error(`tenantSecretHostPath: expected a file: ref, got ${ref.split(':', 1)[0]}:`)
  }
  const raw = ref.slice('file:'.length)
  const normalized = posix.normalize(raw)
  if (!isUnder(normalized, TENANT_SUBDIR)) {
    throw new Error(`tenantSecretHostPath: ref file:${raw} is not under the ${TENANT_SUBDIR} tenants subdir`)
  }
  const name = normalized.slice(TENANT_SUBDIR.length)
  const hostRoot = (env.TENANT_SECRETS_DIR ?? './secrets/tenants').replace(/\/$/, '')
  return `${hostRoot}/${name}`
}
