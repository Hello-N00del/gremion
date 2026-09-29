// packages/tenant-store/src/lifecycle/scram.ts
//
// The app role's password is set as a SCRAM-SHA-256 VERIFIER computed here
// (RFC 5802 / RFC 7677, PostgreSQL's stored format), never as the plaintext:
// a plaintext PASSWORD literal in CREATE/ALTER ROLE is visible to
// log_statement=ddl and pg_stat_statements; the verifier is what the server
// would store anyway.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

export const SCRAM_ITERATIONS = 4096

/**
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (base64).
 * The password must be printable ASCII (SASLprep is then the identity), 16 to
 * 256 characters: the lifecycle's secrets are generated, never typed.
 */
export function scramSha256Verifier(password: string, opts: { salt?: Buffer; iterations?: number } = {}): string {
  if (typeof password !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(password)) {
    throw new TypeError('app role password must be 16-256 printable ASCII characters without spaces')
  }
  const salt = opts.salt ?? randomBytes(16)
  const iterations = opts.iterations ?? SCRAM_ITERATIONS
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}
