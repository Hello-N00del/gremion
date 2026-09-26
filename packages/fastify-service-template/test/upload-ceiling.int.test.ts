// T6 (TRD-213): upload-ceiling.int.test.ts. A scaffolded instance on a REAL
// socket (127.0.0.1:0, not inject()), a streamed multipart upload:
//   52 428 800 B (the 50 MiB default) -> 201, server sha256 == client sha256
//   52 428 801 B (limit + 1)          -> 413 application/problem+json with
//                                        the stable type and limitBytes
// The upload handler is what a service author writes into the scaffolded stub:
// it streams the file through a hash and never holds it whole.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_UPLOAD_CEILING_BYTES, getUploadCeilingBytes, PROBLEM_CONTENT_TYPE, PROBLEM_TYPES } from '../src/index.ts'
import { scaffoldService } from '../src/scaffold.ts'
import { FIXTURE_SPEC_PATH, PACKAGE_DIR } from './helpers.ts'

const TMP = join(PACKAGE_DIR, '.tmp', 'upload-int')
const MIB_50 = 52_428_800

// The implementation a service author puts in the scaffolded stub.
const STREAMING_UPLOAD_HANDLER = `import { createHash } from 'node:crypto'
import type { OperationHandler } from '@gremion/fastify-service-template'

export default (async (request, reply) => {
  const part = await (request as any).file()
  const hash = createHash('sha256')
  let bytes = 0
  let chunks = 0
  let maxChunkBytes = 0
  for await (const chunk of part.file) {
    hash.update(chunk)
    bytes += chunk.length
    chunks++
    if (chunk.length > maxChunkBytes) maxChunkBytes = chunk.length
  }
  reply.code(201)
  return { sha256: hash.digest('hex'), bytes, chunks, maxChunkBytes }
}) satisfies OperationHandler
`

interface UploadResult {
  status: number
  contentType: string
  body: string
  clientSha256: string
}

/**
 * Stream `size` random bytes as one multipart file part over a real socket,
 * 64 KiB at a time, honouring backpressure. The request is never built in
 * memory. Resolves with the response (which, for a 413, may arrive before the
 * client finished writing; a reset after the response is then expected).
 */
function streamUpload(port: number, size: number): Promise<UploadResult> {
  const boundary = `----gremion-${randomBytes(12).toString('hex')}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob.bin"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const hash = createHash('sha256')
  return new Promise((resolve, reject) => {
    let responded = false
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/uploads',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': head.length + size + tail.length,
        },
      },
      (res) => {
        responded = true
        const parts: Buffer[] = []
        res.on('data', (c: Buffer) => parts.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(parts).toString('utf8'),
            clientSha256: hash.digest('hex'),
          }),
        )
      },
    )
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (responded && (e.code === 'EPIPE' || e.code === 'ECONNRESET')) return
      reject(e)
    })
    const CHUNK = 64 * 1024
    let sent = 0
    const pump = () => {
      while (sent < size) {
        if (responded) return
        const n = Math.min(CHUNK, size - sent)
        const chunk = randomBytes(n)
        hash.update(chunk)
        sent += n
        if (!req.write(chunk)) {
          req.once('drain', pump)
          return
        }
      }
      req.end(tail)
    }
    req.write(head)
    pump()
  })
}

describe('upload-ceiling.int.test.ts: the 50 MiB platform default, end to end on a scaffolded instance', () => {
  let app: FastifyInstance
  let port: number

  beforeAll(async () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(join(TMP, 'spec'), { recursive: true })
    const specPath = join(TMP, 'spec', 'widgets.openapi.json')
    copyFileSync(FIXTURE_SPEC_PATH, specPath)
    const outDir = join(TMP, 'svc')
    scaffoldService({ spec: specPath, out: outDir })
    writeFileSync(join(outDir, 'src', 'handlers', 'uploadFile.ts'), STREAMING_UPLOAD_HANDLER)
    const mod = await import(pathToFileURL(join(outDir, 'src', 'index.ts')).href)
    app = mod.buildApp() // no config: the template default applies
    await app.listen({ host: '127.0.0.1', port: 0 })
    port = (app.server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await app?.close()
    rmSync(TMP, { recursive: true, force: true })
  })

  it('the default ceiling is 50 MiB = 52 428 800 bytes', () => {
    expect(DEFAULT_UPLOAD_CEILING_BYTES).toBe(MIB_50)
    expect(getUploadCeilingBytes(app)).toBe(MIB_50)
  })

  it('accepts a 52 428 800-byte file: 201 and the server checksum matches the client one', async () => {
    const r = await streamUpload(port, MIB_50)
    expect(r.status, r.body).toBe(201)
    const body = JSON.parse(r.body)
    expect(body.bytes).toBe(MIB_50)
    expect(body.sha256).toBe(r.clientSha256)
    // Streamed, not buffered whole: the handler saw many bounded chunks.
    expect(body.chunks).toBeGreaterThan(1)
    expect(body.maxChunkBytes).toBeLessThanOrEqual(1024 * 1024)
  }, 120_000)

  it('rejects 52 428 801 bytes with a typed 413 problem+json naming the limit', async () => {
    const r = await streamUpload(port, MIB_50 + 1)
    expect(r.status, r.body).toBe(413)
    expect(r.contentType).toContain(PROBLEM_CONTENT_TYPE)
    const problem = JSON.parse(r.body)
    expect(problem).toMatchObject({
      type: PROBLEM_TYPES.payloadTooLarge,
      status: 413,
      limitBytes: MIB_50,
    })
    expect(problem.type).toBe('urn:gremion:problem:payload-too-large')
  }, 120_000)

  it('the service still answers after a rejected upload', async () => {
    const r = await streamUpload(port, 1024)
    expect(r.status, r.body).toBe(201)
    expect(JSON.parse(r.body).sha256).toBe(r.clientSha256)
  })
})
