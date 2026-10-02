// modules/board/test/isolation/leaf-api.ts
//
// The leaf adapter of BoardApi: the internal-headers transport (x-internal-auth,
// x-tenant-id, x-tenant-slug) against a leaf built by buildApp(env) and
// listening on 127.0.0.1. `as` is sent verbatim, so a caller can forge a
// mismatched id/slug pair (vector H).
import http from 'node:http'
import type { TenantRef } from '../../src/store/index.ts'
import type { ApiResult, BoardApi } from './api.ts'

export function leafRequest(
  server: http.Server,
  secret: string,
  as: TenantRef,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult & { headers: http.IncomingHttpHeaders }> {
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('[leaf-api] the leaf is not listening')
  const payload = body !== undefined ? JSON.stringify(body) : undefined
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        method,
        path,
        headers: {
          'x-internal-auth': secret,
          'x-tenant-id': as.id,
          'x-tenant-slug': as.slug,
          'content-type': 'application/json',
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let parsed: unknown = raw
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

export function leafApi(server: http.Server, secret: string): BoardApi {
  const call = (as: TenantRef, method: string, path: string, body?: unknown): Promise<ApiResult> =>
    leafRequest(server, secret, as, method, path, body).then(({ status, body: b }) => ({ status, body: b }))
  const seg = encodeURIComponent
  return {
    listBoards: (as, orgUnitIds) =>
      call(as, 'GET', `/api/v1/boards${orgUnitIds.length ? '?' + orgUnitIds.map((o) => `orgUnitId=${seg(o)}`).join('&') : ''}`),
    getBoard: (as, id) => call(as, 'GET', `/api/v1/boards/${seg(id)}`),
    deck: (as, id) => call(as, 'GET', `/api/v1/boards/${seg(id)}/deck`),
    createBoard: (as, input) => call(as, 'POST', '/api/v1/boards', input),
    createStack: (as, id, input) => call(as, 'POST', `/api/v1/boards/${seg(id)}/stacks`, input),
    createCard: (as, input) => call(as, 'POST', '/api/v1/cards', input),
    moveCard: (as, id, to) => call(as, 'PATCH', `/api/v1/cards/${seg(id)}/move`, to),
    promote: (as, id, input) => call(as, 'POST', `/api/v1/boards/${seg(id)}/promote`, input),
    promoted: (as, candidateIds) => call(as, 'POST', '/api/v1/cards/promoted', { candidateIds }),
  }
}
