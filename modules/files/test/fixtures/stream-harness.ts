// modules/files/test/fixtures/stream-harness.ts
// Child-process harness for the F1-FIX-03 / S4#0 + K5#16 guard. It starts the
// REAL files-leaf HTTP server in its own process with a stub WebDAV client whose
// download body sends one chunk and then either:
//   - errors (an upstream Nextcloud reset mid-body, code ECONNRESET), or
//   - never ends, when the requested path contains "/hang/" (so the CLIENT can
//     abort the download; round 2: that is logged at info level, not as an
//     upstream failure).
// It prints {"port":N} once listening. The parent test then checks that the
// process is still alive and still answering after that download.
// Run with: node --import tsx test/fixtures/stream-harness.ts
import type { AddressInfo } from 'node:net'
import { createServer } from '../../src/http/server.ts'
import type { WebdavClient } from '../../src/nextcloud/webdav-client.ts'

function failingBody(): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode('first bytes of the file '))
        return Promise.resolve()
      }
      // Fail a moment later, so the status line and the first chunk are on the
      // wire first (a real mid-body reset, not a failure before any byte).
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const err = new Error('upstream reset mid-body (harness)') as Error & { code?: string }
          err.code = 'ECONNRESET'
          controller.error(err)
          resolve()
        }, 200)
      })
    },
  })
}

function hangingBody(): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode('first bytes of a slow file '))
        return Promise.resolve()
      }
      // Never resolves: the body stays open until the client goes away.
      return new Promise<void>(() => {})
    },
  })
}

const client = {
  download: async (p: string) =>
    new Response(p.includes('/hang/') ? hangingBody() : failingBody(), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }),
} as unknown as WebdavClient

const server = createServer({ secret: 'harness-secret', client })
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo
  process.stdout.write(JSON.stringify({ port }) + '\n')
})
