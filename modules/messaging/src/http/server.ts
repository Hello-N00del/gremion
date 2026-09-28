// services/messages/src/http/server.ts
// The node:http server for the messages+video leaf (NO web framework). Request
// lifecycle:
//   /healthz          → guard-EXEMPT, returns {"status":"ok"}
//   /api/v1/*         → checkGuard() (403 bad secret / 400 bad tenant headers),
//                       then read the JSON body and dispatch the matching OP to
//                       http/dispatch.ts (per-op Matrix/LiveKit/Synapse forward).
//   everything else   → 404
//
// The leaf is a THIN proxy: each op forwards the kernel-supplied Matrix request
// (+ the user's per-request Matrix token, or the admin token for admin ops) to
// Synapse / LiveKit and relays the result as the exact JSON envelope the kernel
// ServiceMessagesClient expects. Forwarding is only reached when
// MESSAGES_BACKEND=service (the HELD cutover); flag OFF the kernel uses its
// in-process clients and never calls this surface.
import http from 'node:http'
import { checkGuard, isHealthzPath } from './auth.js'
import { OPERATION_BY_PATH } from '../operations.js'
import { dispatchOp } from './dispatch.js'
import { buildEnvDeps, type LeafDeps } from './deps.js'

export interface ServerOptions {
  /** Shared secret expected in x-internal-auth (INTERNAL_MESSAGES_SECRET). */
  secret: string | undefined
  /** Forwarding dependencies (Matrix/Synapse/LiveKit clients). Defaults to
   *  buildEnvDeps() (leaf env). Injectable for tests. */
  deps?: LeafDeps
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createServer(opts: ServerOptions): http.Server {
  const deps = opts.deps ?? buildEnvDeps()

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[messages] unhandled request error', err)
      if (!res.headersSent) sendJson(res, 500, { success: false, error: 'internal error' })
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    // Health probe: exempt from the guard, no tenant context.
    if (isHealthzPath(path)) {
      if (method !== 'GET') return sendJson(res, 405, { success: false, error: 'method not allowed' })
      return sendJson(res, 200, { status: 'ok' })
    }

    // Internal guard: shared secret (constant-time) + tenant headers.
    const guard = checkGuard({
      path,
      headers: req.headers as Record<string, string | undefined>,
      secret: opts.secret,
    })
    if (!guard.ok) return sendJson(res, guard.status, { success: false, error: guard.message })

    // Router: match the internal op by path.
    const op = OPERATION_BY_PATH.get(path)
    if (!op) return sendJson(res, 404, { success: false, error: 'not found' })
    if (method !== 'POST') return sendJson(res, 405, { success: false, error: 'method not allowed' })

    // Matched + guarded → forward the op to Matrix/LiveKit/Synapse.
    let body: Record<string, unknown>
    try {
      const raw = (await readBody(req)).toString('utf8')
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      return sendJson(res, 400, { success: false, error: 'invalid JSON body' })
    }

    const result = await dispatchOp(op, body, deps)
    return sendJson(res, result.status, result.body)
  }
}
