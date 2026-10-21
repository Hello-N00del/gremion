// services/kernel-api/src/tenancy/secrets.ts — the kernel API's own
// secret-ref resolver (lane note C10). gremion-ui's resolveSecret
// (tenant/secrets.ts) imports $env and is SvelteKit-bound; the RULES are the
// same: two schemes, fail closed, never an empty secret, never the value in an
// error.
//   file:<path>  a mounted file, normalised FIRST, then required to sit under
//                /run/secrets/ (no traversal out of the mount);
//   env:<VAR>    a variable of the env object handed in. TEST FIXTURES ONLY and
//                REFUSED unless the caller opts in explicitly (allowEnvRefs, which
//                the services derive from KERNEL_API_ALLOW_ENV_SECRET_REFS=1; no
//                production config sets it): the provisioning engine writes file:
//                refs, and an env: ref in a production registry row would put a
//                database credential in the container environment.
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'

export const SECRET_PREFIX = '/run/secrets/'

/** The explicit opt-in for env: refs (tests, the scratch stack proof). Production config never sets it. */
export const ALLOW_ENV_SECRET_REFS_VAR = 'KERNEL_API_ALLOW_ENV_SECRET_REFS'

/** The opt-in as the services read it from their environment. */
export const allowsEnvRefs = (env: Readonly<Record<string, string | undefined>>): boolean => env[ALLOW_ENV_SECRET_REFS_VAR] === '1'

export class SecretRefError extends Error {
  override name = 'SecretRefError'
}

export interface SecretResolverOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** Accept env:<VAR> refs. Default false: they are refused (fail closed). */
  allowEnvRefs?: boolean
  /** Test seam: where file: refs are read (default node:fs readFileSync). */
  readFile?: (path: string) => string
}

export function createSecretResolver(o: SecretResolverOptions = {}): (ref: string) => string {
  const env = o.env ?? process.env
  const readFile = o.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  return (ref: string) => {
    if (typeof ref !== 'string') throw new SecretRefError('secret ref is not a string')
    if (ref.startsWith('file:')) {
      const normalised = posix.normalize(ref.slice('file:'.length))
      if (!normalised.startsWith(SECRET_PREFIX)) throw new SecretRefError(`secret ref file:${ref.slice(5)} is outside ${SECRET_PREFIX}`)
      let value: string
      try {
        value = readFile(normalised).trim()
      } catch (err) {
        throw new SecretRefError(`secret ref ${normalised} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'read failed'})`)
      }
      if (!value) throw new SecretRefError(`secret ref ${normalised} is empty`)
      return value
    }
    if (ref.startsWith('env:')) {
      if (!o.allowEnvRefs) throw new SecretRefError('secret ref scheme env: is not enabled (test fixtures only; use file:)')
      const name = ref.slice('env:'.length)
      const value = env[name]?.trim()
      if (!value) throw new SecretRefError(`secret ref env:${name} is unset`)
      return value
    }
    throw new SecretRefError(`unsupported secret ref scheme ${JSON.stringify(ref.split(':', 1)[0])}`)
  }
}
