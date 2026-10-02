// gremion-ui/src/lib/server/messages/backend/inprocess-client.ts
// Branch-by-abstraction default path; byte-identical to the pre-seam messages+video
// behavior until the deliberate (HELD) cutover to 'service'.
//
// Every accessor is a thin delegate to the kernel's existing per-tenant clients
// (getMatrixClient / getSynapseAdmin) and the shared livekit-client + matrix-creds
// helpers — exactly the modules the routes imported directly pre-seam. The routes
// keep their orchestration verbatim; only the import moves to the seam, so
// behavior stays byte-identical. No logic lives here beyond that delegation.
//
// livekit() returns a FRESH object referencing the live module bindings on every
// call so vi.mock('$lib/server/messages/livekit-client') in the route tests keeps
// intercepting mintToken/roomNameFromMatrixId/dmRoomName through the seam.

import type { RequestEvent } from '@sveltejs/kit'
import { getMatrixClient } from '../matrix-client'
import { getSynapseAdmin } from '../synapse-admin'
import { mintToken, roomNameFromMatrixId, dmRoomName } from '../livekit-client'
import { resolveMatrixCreds } from '../matrix-creds'
import type {
  LivekitPort,
  MatrixClientPort,
  MatrixCreds,
  MessagesBackendPort,
  SynapseAdminPort,
} from './port'

export class InprocessMessagesClient implements MessagesBackendPort {
  readonly kind = 'inprocess' as const

  matrix(): MatrixClientPort {
    return getMatrixClient()
  }

  synapse(): SynapseAdminPort {
    return getSynapseAdmin()
  }

  livekit(): LivekitPort {
    return { mintToken, roomNameFromMatrixId, dmRoomName }
  }

  resolveMatrixCreds(event: RequestEvent): Promise<MatrixCreds> {
    return resolveMatrixCreds(event)
  }
}
