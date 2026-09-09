import { env } from '$env/dynamic/private'
export function badPool() {
  const url = env.DATABASE_URL
  const nc = env.NEXTCLOUD_ADMIN_PASSWORD ?? ''
  const syn = env['SYNAPSE_SERVER_NAME'] ?? 'localhost'
  return { url, nc, syn }
}
