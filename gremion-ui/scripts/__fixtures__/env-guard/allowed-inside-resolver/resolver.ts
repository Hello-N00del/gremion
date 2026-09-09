import { env } from '$env/dynamic/private'
export function defaultProfile() {
  return { databaseUrl: env.DATABASE_URL, issuer: env.AUTH_KEYCLOAK_ISSUER, configPath: env.CONFIG_PATH ?? '/app/config/config.json' }
}
