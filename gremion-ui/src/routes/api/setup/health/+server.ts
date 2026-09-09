import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { createConnection } from 'node:net'
import { env } from '$env/dynamic/private'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import type { ApiResponse } from '$lib/api-response'
import { validateSetupToken } from '$lib/server/setup-token'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'

type ServiceStatus = 'healthy' | 'unhealthy' | 'warning'
// 'unchecked' — credential probe not applicable (e.g. postgres/redis) or not run.
type CredentialStatus = 'valid' | 'invalid' | 'unchecked'

interface ServiceHealth {
  status: ServiceStatus
  reachable: boolean
  /** Whether admin credentials for this service were accepted. `null` when no
   *  credentialed probe applies (postgres/redis are bare TCP checks). */
  credentialsValid: boolean | null
}

function tcpCheck(host: string, port: number, timeout = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeout)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function httpCheck(url: string, timeout = 3000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

function settled(p: PromiseSettledResult<boolean>): boolean {
  return p.status === 'fulfilled' && p.value
}

export const GET: RequestHandler = async ({ request, locals }) => {
  if (!validateSetupToken(request.headers.get('X-Setup-Token'))) {
    return json({ success: false, error: 'Invalid or missing setup token' }, { status: 401 })
  }

  const postgresHost = env.POSTGRES_HOST ?? 'postgres'
  const postgresPort = parseInt(env.POSTGRES_PORT ?? '5432', 10)
  const keycloakUrl = (defaultTenantEnv('KEYCLOAK_ADMIN_URL') ?? 'http://keycloak:8080').replace(/\/$/, '')
  const redisHost = env.REDIS_HOST ?? 'redis'
  const redisPort = parseInt(env.REDIS_PORT ?? '6379', 10)

  // Reachability probes. (open-core carve) The Nextcloud + Helios probes were
  // removed with those satellite services — the governance kernel ships neither,
  // so probing them always failed and could never gate setup. A re-added
  // files/elections module contributes its own reachability probe via a
  // registered slot, not a hardcoded check here.
  const [postgres, keycloak, redis] = await Promise.allSettled([
    tcpCheck(postgresHost, postgresPort),
    httpCheck(`${keycloakUrl}/health/ready`),
    tcpCheck(redisHost, redisPort),
  ])

  const keycloakReachable = settled(keycloak)

  // Credential probes — only worth running if the service is reachable.
  // Each helper swallows its own errors and returns a boolean, so we never
  // throw out of the health endpoint. Reusing the existing admin clients keeps
  // the auth flow identical to the one provisioning later relies on, so a green
  // probe here genuinely predicts provisioning success (#191).
  //
  // (open-core carve) The Synapse + Nextcloud credential probes lived in the
  // messages/files FEATURE modules (self-registered on the runtime-registry) and
  // were removed with them. Only the Keycloak probe remains (keycloak-admin is a
  // kernel client).
  const [kcCreds] = await Promise.allSettled([
    keycloakReachable ? getKeycloakAdminClient(locals.tenant).validateCredentials() : Promise.resolve(false),
  ])

  const keycloakCredsValid = keycloakReachable ? settled(kcCreds) : false

  // A service with an admin credential is only "healthy" when it is BOTH
  // reachable AND its admin credentials are accepted — so a wrong/empty secret
  // can no longer hide behind mere reachability.
  const detailed: Record<string, ServiceHealth> = {
    postgres: {
      status: settled(postgres) ? 'healthy' : 'unhealthy',
      reachable: settled(postgres),
      credentialsValid: null,
    },
    keycloak: {
      status: keycloakReachable && keycloakCredsValid ? 'healthy' : 'unhealthy',
      reachable: keycloakReachable,
      credentialsValid: keycloakReachable ? keycloakCredsValid : null,
    },
    redis: {
      status: settled(redis) ? 'healthy' : 'unhealthy',
      reachable: settled(redis),
      credentialsValid: null,
    },
  }

  // Backward-compatible flat status map the existing UI already reads.
  const services: Record<string, ServiceStatus> = Object.fromEntries(
    Object.entries(detailed).map(([k, v]) => [k, v.status])
  )

  // Distinct credential view: 'valid' | 'invalid' | 'unchecked' per service.
  const credentials: Record<string, CredentialStatus> = {
    postgres: 'unchecked',
    keycloak: keycloakReachable ? (keycloakCredsValid ? 'valid' : 'invalid') : 'unchecked',
    redis: 'unchecked',
  }

  const requiredServices = ['postgres', 'keycloak', 'redis'] as const
  // Gate on the detailed status, which already folds in credential validity for
  // keycloak — an all-green-on-reachability result can no longer pass when an
  // admin secret is wrong or empty (#191).
  const can_proceed = requiredServices.every((s) => detailed[s].status === 'healthy')

  const body: ApiResponse<{
    services: Record<string, ServiceStatus>
    serviceDetails: Record<string, ServiceHealth>
    credentials: Record<string, CredentialStatus>
    can_proceed: boolean
  }> = {
    success: true,
    data: { services, serviceDetails: detailed, credentials, can_proceed },
  }

  return json(body)
}
