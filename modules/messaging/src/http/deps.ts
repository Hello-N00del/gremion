// services/messages/src/http/deps.ts
// The leaf's forwarding dependencies, resolved from its OWN env. Grouped so
// http/dispatch.ts stays pure (deps in) and tests can inject fakes (route-parity)
// or exercise the real clients over a stubbed global fetch (forwarding).
//
// The leaf is a stateless per-process proxy configured for one Synapse/LiveKit
// deployment: MATRIX_URL / SYNAPSE_ADMIN_TOKEN / SYNAPSE_SERVER_NAME /
// LIVEKIT_API_KEY / LIVEKIT_API_SECRET. The kernel forwards the per-request user
// token (or Keycloak JWT) + the already-computed LiveKit room name, so the leaf
// needs no per-tenant registry here.
import { createMatrixClient, matrixBaseUrl, type MatrixLeafClient } from '../matrix/matrix-client.js'
import { createSynapseAdmin, type SynapseLeafAdmin } from '../matrix/synapse-admin.js'
import type { LivekitConfig } from '../livekit/livekit-client.js'

export interface LeafDeps {
  matrix: MatrixLeafClient
  synapse: SynapseLeafAdmin
  livekit: LivekitConfig
}

/** Secrets the leaf cannot run without. An empty LIVEKIT_API_SECRET would sign
 *  LiveKit tokens with ''; an empty SYNAPSE_ADMIN_TOKEN turns every admin op
 *  into an unauthenticated call. index.ts refuses to boot while any is empty. */
export const REQUIRED_LEAF_SECRETS = ['LIVEKIT_API_SECRET', 'SYNAPSE_ADMIN_TOKEN'] as const

/** The required secrets that are unset or blank in `env`. */
export function missingLeafSecrets(env: Record<string, string | undefined>): string[] {
  return REQUIRED_LEAF_SECRETS.filter((name) => (env[name] ?? '').trim() === '')
}

/** Build the leaf's forwarding clients from the leaf's OWN env. */
export function buildEnvDeps(): LeafDeps {
  const baseUrl = matrixBaseUrl()
  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN ?? ''
  const serverName = process.env.SYNAPSE_SERVER_NAME ?? 'localhost'
  return {
    matrix: createMatrixClient({ baseUrl, adminToken, serverName }),
    synapse: createSynapseAdmin({ baseUrl, adminToken, serverName }),
    livekit: {
      apiKey: process.env.LIVEKIT_API_KEY ?? '',
      apiSecret: process.env.LIVEKIT_API_SECRET ?? '',
    },
  }
}
