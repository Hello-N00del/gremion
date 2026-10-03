// Fixture for check-tenant-env-guard (TASK-205, verifier r1 MEDIUM): serviceEnv reads process.env with a
// computed key, which the env.X / env['X'] pattern cannot see, so the guard reads the serviceEnv call
// sites themselves. A service-endpoint literal is fine; a non-endpoint literal and a computed name are not.
declare const serviceEnv: (name: string) => string | undefined

export function calls(name: string) {
  const matrix = serviceEnv('MATRIX_URL')
  const nc = serviceEnv("NEXTCLOUD_URL")
  const db = serviceEnv('DATABASE_URL')
  const secret = serviceEnv('AUTH_KEYCLOAK_SECRET')
  const hidden = serviceEnv(name)
  return { matrix, nc, db, secret, hidden }
}
