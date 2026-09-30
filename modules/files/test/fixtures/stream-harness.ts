// modules/files/test/fixtures/stream-harness.ts
// Child-process harness for the F1-FIX-03 / S4#0 + K5#16 guard. It starts the
// REAL files-leaf HTTP server in its own process with a stub WebDAV client whose
// download body sends one chunk and then errors (an upstream Nextcloud reset
// mid-body). It prints {"port":N} once listening. The parent test then checks
// that the process is still alive and still answering after that download.
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
        return
      }
      controller.error(new Error('upstream reset mid-body (harness)'))
    },
  })
}

const client = {
  download: async () =>
    new Response(failingBody(), { status: 200, headers: { 'content-type': 'application/pdf' } }),
} as unknown as WebdavClient

const server = createServer({ secret: 'harness-secret', client })
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo
  process.stdout.write(JSON.stringify({ port }) + '\n')
})
